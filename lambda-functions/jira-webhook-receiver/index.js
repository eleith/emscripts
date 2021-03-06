const JiraConnector = require('jira-connector');
const config = require('./config');
const { WebClient } = require('@slack/client');
const slackUtils = require('./slack-utils');

const slackWebClient = new WebClient(config.slack.api_token);

const getValueOrNameFromArray = (array) => {
  let values = [];

  if (Array.isArray(array)) {
    values = array.map(element => element.value || element.name);
  }

  return values;
};

const testRule = (rule, value, ...extras) => {
  let test = true;

  if (rule !== null) {
    if (rule instanceof RegExp) {
      test = rule.test(Array.isArray(value) ? value.join(',') : value || '');
    } else if (rule instanceof Function) {
      test = rule(value, ...extras);
    } else {
      test = Array.isArray(value) ? value.some(v => v === rule) : rule === value;
    }
  }

  return test;
};

const slackIssue = (slack, ...extras) => new Promise((resolve, reject) => {
  let attachments;

  if (slack.attachments) {
    attachments = (slack.attachments instanceof Function) ?
      slack.attachments(...extras) :
      slack.attachments;
  }

  const message = {
    channel: (slack.channel instanceof Function) ? slack.channel(...extras) : slack.channel,
    text: (slack.message instanceof Function) ? slack.message(...extras) : slack.message,
    options: {
      reply_broadcast: true,
      attachments: Array.isArray(attachments) ? attachments : [attachments],
      username: slack.bot_name || config.slack.bot_name,
      icon_emoji: slack.bot_emoji ? `:${slack.bot_emoji}:` : `:${config.slack.bot_emoji}:`,
    },
  };

  if (config.mode !== 'dryrun') {
    console.log('posting message to slack ', message); // eslint-disable-line no-console
    slackWebClient.chat.postMessage(message.channel, message.text, message.options, (error) => {
      if (error) {
        console.log('failed to post slack message: ', error); // eslint-disable-line no-console
        reject(error);
      } else {
        console.log(`posted slack message to ${message.channel}`); // eslint-disable-line no-console
        resolve();
      }
    });
  } else {
    console.log('dry run enabled. would have posted message to slack ', message, '\n'); // eslint-disable-line no-console
    resolve();
  }
});

const updateIssueField = (issueOptions, field, value) => {
  /* eslint-disable no-param-reassign */
  if (!issueOptions.issue.update) {
    issueOptions.issue.update = {};
  }

  if (!issueOptions.issue.update[field]) {
    issueOptions.issue.update[field] = [];
  }

  if (/comment/.test(field)) {
    issueOptions.issue.update[field].push({ add: { body: value } });
  } else if (/component/.test(field)) {
    issueOptions.issue.update[field].push({ add: { name: value } });
  } else if (/labels/.test(field)) {
    issueOptions.issue.update[field].push({ add: value });
  }
  /* eslint-enable no-param-reassign */
};

const editIssue = (edits, issue, changelog, webhookEvent) => new Promise((resolve, reject) => {
  const issueOptions = {
    issueKey: issue.key,
    issue: {
      fields: {},
    },
  };

  Object.keys(edits).forEach((edit) => {
    let editValue;

    if (edits[edit] instanceof Function) {
      editValue = edits[edit](issue, changelog, webhookEvent);
    } else {
      editValue = edits[edit];
    }

    if (/comment|components|labels/.test(edit)) {
      if (Array.isArray(editValue)) {
        editValue.forEach((value) => {
          updateIssueField(issueOptions, edit, value);
        });
      } else if (typeof editValue === 'string') {
        updateIssueField(issueOptions, edit, editValue);
      }
    } else {
      issueOptions.issue.fields[edit] = editValue;
    }
  });

  if (config.mode !== 'dryrun') {
    console.log('edited issue with: ', JSON.stringify(issueOptions)); // eslint-disable-line no-console
    const Jira = new JiraConnector(config.jira);
    Jira.issue.editIssue(issueOptions, (err) => {
      if (err) {
        console.log(`Error while updating the issue ${issue.key}`, err); // eslint-disable-line no-console
        reject(err);
      } else {
        console.log(`Successfully updated the issue ${issue.key}:`); // eslint-disable-line no-console
        resolve();
      }
    });
  } else {
    console.log('dry run enabled. would have edited issue with %j\n', JSON.stringify(issueOptions)); // eslint-disable-line no-console
    resolve();
  }
});

const filterIssue = (issueTest, issue, changelog, webhook) => {
  let test = true;

  if (issueTest) {
    Object.keys(issueTest).forEach((field) => {
      const value = issue.fields[field];

      if (value === null || value === undefined) {
        test = test && testRule(issueTest[field], value, issue, changelog, webhook);
      } else if (Array.isArray(value)) {
        const flat = getValueOrNameFromArray(value);
        test = test && testRule(issueTest[field], flat, issue, changelog, webhook);
      } else if (value && (value.key !== undefined || value.name !== undefined)) {
        let testKey;
        let testName;
        if (value.key !== undefined) {
          testKey = testRule(issueTest[field], value.key, issue, changelog, webhook);
        }
        if (value.name !== undefined) {
          testName = testRule(issueTest[field], value.name, issue, changelog, webhook);
        }
        test = test && (testName || testKey);
      } else {
        // if value is an object we didn't expect, don't flag a match
        test = false;
      }

      if (config.mode === 'dryrun') {
        console.log(`testing ${field} and result is ${test}`); // eslint-disable-line no-console
      }
    });
  }

  return test;
};

const filterChangelog = (rules, fields, value, issue, webhook) => {
  let test = true;
  let found = 0;

  if (value && value.items && value.items.length) {
    value.items.forEach((change) => {
      const shouldWatch = fields.some(x => x === change.field);
      if (rules[change.field] !== undefined && shouldWatch) {
        const rule = rules[change.field];
        test = test && testRule(rule, change.toString, issue, value, webhook);
        found += 1;

        if (config.mode === 'dryrun') {
          console.log(`testing change of ${change.field} to ${change.toString} against ${rule} is ${test}`); // eslint-disable-line no-console
        }
      }
    });
  } else {
    test = false;
  }

  return found > 0 && test;
};

exports.onReceive = (event, context, callback) => {
  const jiraData = JSON.parse(event.body);
  const { changelog, issue, issue_event_type_name: webhookEvent } = jiraData;
  const followup = { edit: [], slack: [] };

  let promiseChain = Promise.resolve();

  if (!issue) {
    callback(null, { statusCode: 200, body: 'no issue found' });
    return;
  }

  console.log('Issue: %j\n', issue); // eslint-disable-line no-console
  console.log('webhookevent', webhookEvent, '\n'); // eslint-disable-line no-console

  if (changelog) {
    console.log('ChangeLog', changelog, '\n'); // eslint-disable-line no-console
  }

  (config.rules || []).forEach((rule) => {
    if (rule.if !== null && rule.if.constructor === Object) {
      let test = true;

      if (test && rule.if.event) {
        test = test && testRule(rule.if.event, webhookEvent);
      }

      if (test && rule.if.issue) {
        if (changelog && changelog.items && !(/issue_created|issue_moved|issue_reopened/.test(webhookEvent))) {
          const watch = rule.if.change || Object.keys(rule.if.issue);
          const fields = Array.isArray(watch) ? watch : [watch];
          test = filterChangelog(rule.if.issue, fields, changelog, issue, webhookEvent) &&
            filterIssue(rule.if.issue, issue, changelog, webhookEvent);
        } else {
          test = filterIssue(rule.if.issue, issue, null, webhookEvent);
        }
      }

      if (test) {
        console.log(`rule passed for "${rule.description}"\n`); // eslint-disable-line no-console

        if (rule.then.edit) {
          followup.edit.push(rule.then.edit);
        }

        if (rule.then.slack) {
          if (Array.isArray(rule.then.slack)) {
            followup.slack.push(...rule.then.slack);
          } else {
            followup.slack.push(rule.then.slack);
          }
        }
      } else if (config.mode === 'dryrun') {
        console.log(`rule failed for "${rule.description}"\n`); // eslint-disable-line no-console
      }
    }
  });

  if (followup.edit.length > 0) {
    const edits = followup.edit.reduce((x, y) => Object.assign(x, y));
    promiseChain = promiseChain.then(() => editIssue(edits, issue, changelog, webhookEvent));
  }

  if (followup.slack.length > 0) {
    if (config.mode !== 'dryrun') {
      promiseChain = promiseChain.then(() => new Promise((resolve, reject) => {
        slackWebClient.users.list({ presence: false }, (error, res) => {
          if (error) {
            console.log('error', res); // eslint-disable-line no-console
            reject(error);
          } else {
            slackUtils.slackUsers = res.members;
            resolve(res.members);
          }
        });
      }));
    }

    followup.slack.forEach((slack) => {
      promiseChain = promiseChain.then(() => slackIssue(slack, issue, changelog, webhookEvent));
    });
  }

  promiseChain.then(() => callback(null, { statusCode: 200, body: 'webhook ran without error' })).catch((error) => {
    console.error(error); // eslint-disable-line no-console
    callback(null, { statusCode: 200, body: 'webhook had an error' });
  });
};

if (require.main === module) {
  const jiraHooks = [
    {
      issue: {
        key: 'FLEX-1337',
        fields: {
          project: { key: 'FLEX' },
          // priority: { name: 'Major' },
          // status: { name: 'Resolved' },
          resolution: { name: 'Fixed' },
          assignee: { name: 'eleith', emailAddress: 'eleith@coursera.org' },
          // duedate: '2018-11-20',
          issuetype: { name: 'Bug' },
          components: [],
        },
      },
      changelog: {
        items: [{
          field: 'resolution',
          fromString: null,
          toString: 'Fixed',
        },
        ],
      },
      type: 'issue_resolved',
      /*
      issue: {
        key: 'PROJECT-1337',
        fields: {
          project: { key: 'PROJECT', name: 'Project' },
          priority: { name: 'Major' },
          // status: { name: 'Resolved' },
          resolution: null,
          assignee: { name: 'eleith' },
          // duedate: '2018-11-20',
          issuetype: { name: 'Epic' },
          components: [],
        },
      },
      changelog: {
        items: [{
          field: 'assignee',
          fromString: null,
          toString: 'eleith',
        }, {
          field: 'priority',
          fromString: null,
          toString: 'Major',
        },
        ],
      },
      type: 'issue_created',
      */
    },
  ];

  jiraHooks.forEach((jiraHook) => {
    const json = JSON.stringify({
      issue_event_type_name: jiraHook.type,
      issue: jiraHook.issue,
      changelog: jiraHook.changelog,
    });
    exports.onReceive({ body: json }, {}, () => {});
  });
}
