#!/usr/bin/env node

const DEFAULT_PROJECT_OWNER = "t8y2";
const DEFAULT_PROJECT_NUMBER = 1;
const DEFAULT_REPO = "t8y2/dbx";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// PROJECT_TOKEN is a PAT with project scope; GH_TOKEN / GITHUB_TOKEN (auto-generated) handles repo access
const projectToken = process.env.PROJECT_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const repoTokens = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.PROJECT_TOKEN].filter(Boolean);
const repoToken = repoTokens[0] || "";
const projectOwner = args["project-owner"] || process.env.PROJECT_OWNER || DEFAULT_PROJECT_OWNER;
const projectNumber = Number(args["project-number"] || process.env.PROJECT_NUMBER || DEFAULT_PROJECT_NUMBER);
const repo = args.repo || process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
const [repoOwner, repoName] = repo.split("/");
const issueNumber = args["issue-number"] ? Number(args["issue-number"]) : null;
const mode = args.backfill === "true" ? "backfill" : "issue";
const eventAction = args["event-action"] || process.env.ISSUE_EVENT_ACTION || "";

if (!projectToken) {
  throw new Error("PROJECT_TOKEN, GH_TOKEN, or GITHUB_TOKEN is required");
}
if (!repoToken) {
  throw new Error("GH_TOKEN or GITHUB_TOKEN is required for repository access");
}

if (!repoOwner || !repoName) {
  throw new Error(`Invalid repo: ${repo}`);
}

if (mode === "issue" && !issueNumber) {
  throw new Error("--issue-number is required unless --backfill true is set");
}

function gqlString(value) {
  return JSON.stringify(value);
}

function gqlNumber(value) {
  return Number(value);
}

function gqlNullableString(value) {
  return value == null ? "null" : JSON.stringify(value);
}

async function graphql(query, token) {
  const t = token || repoTokens[0];
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${t}`,
      "Content-Type": "application/json",
      "User-Agent": "dbx-project-triage/1.0",
    },
    body: JSON.stringify({ query }),
  });

  const payload = await resp.json();
  if (payload.errors) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(payload.errors)}`);
  }
  if (!resp.ok) {
    throw new Error(`GraphQL request failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  return payload.data;
}

function triageName(issue) {
  const labels = new Set(issue.labels.nodes.map((label) => label.name));
  if (labels.has("question")) return "Needs Info";
  if (issue.assignees.nodes.length > 0) return "Ready";
  return "Inbox";
}

function singleSelectOptionsByName(field) {
  return Object.fromEntries((field?.options || []).map((option) => [option.name, option.id]));
}

function singleSelectOptionId(options, name) {
  const exact = options[name];
  if (exact) return exact;
  const target = name.toLowerCase();
  const entry = Object.entries(options).find(([optionName]) => optionName.toLowerCase() === target);
  return entry?.[1];
}

async function getProjectConfig() {
  const query = `
    query {
      user(login: ${gqlString(projectOwner)}) {
        projectV2(number: ${gqlNumber(projectNumber)}) {
          id
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, projectToken);
  const project = data.user?.projectV2;
  if (!project) {
    throw new Error(`Project ${projectOwner}#${projectNumber} not found`);
  }

  const triageField = project.fields.nodes.find((field) => field.name === "Triage");
  if (!triageField) {
    throw new Error(`Project ${project.title} is missing a Triage field`);
  }
  const statusField = project.fields.nodes.find((field) => field.name === "Status");

  return {
    id: project.id,
    title: project.title,
    triageFieldId: triageField.id,
    triageOptions: singleSelectOptionsByName(triageField),
    statusFieldId: statusField?.id || "",
    statusOptions: singleSelectOptionsByName(statusField),
  };
}

async function fetchIssue(number) {
  const query = `
    query {
      repository(owner: ${gqlString(repoOwner)}, name: ${gqlString(repoName)}) {
        issue(number: ${gqlNumber(number)}) {
          id
          number
          title
          url
          state
          assignees(first: 20) {
            nodes {
              login
            }
          }
          labels(first: 50) {
            nodes {
              name
            }
          }
          projectItems(first: 50) {
            nodes {
              id
              project {
                id
                number
                title
                owner {
                  __typename
                  ... on User {
                    login
                  }
                  ... on Organization {
                    login
                  }
                }
              }
              fieldValueByName(name: "Triage") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                }
              }
              statusValue: fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, repoToken);
  const issue = data.repository?.issue;
  if (!issue) {
    throw new Error(`Issue #${number} not found in ${repo}`);
  }
  return issue;
}

async function addItemToProject(projectId, contentId) {
  const mutation = `
    mutation {
      addProjectV2ItemById(input: { projectId: ${gqlString(projectId)}, contentId: ${gqlString(contentId)} }) {
        item {
          id
        }
      }
    }
  `;

  const data = await graphql(mutation, projectToken);

  return data.addProjectV2ItemById.item.id;
}

async function updateTriage({ projectId, itemId, fieldId, optionId }) {
  const mutation = `
    mutation {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: ${gqlString(projectId)}
          itemId: ${gqlString(itemId)}
          fieldId: ${gqlString(fieldId)}
          value: { singleSelectOptionId: ${gqlString(optionId)} }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  await graphql(mutation, projectToken);
}

async function updateSingleSelectField({ projectId, itemId, fieldId, optionId }) {
  const mutation = `
    mutation {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: ${gqlString(projectId)}
          itemId: ${gqlString(itemId)}
          fieldId: ${gqlString(fieldId)}
          value: { singleSelectOptionId: ${gqlString(optionId)} }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  await graphql(mutation, projectToken);
}

async function syncIssue(projectConfig, number) {
  const issue = await fetchIssue(number);
  const targetTriage = triageName(issue);
  const optionId = projectConfig.triageOptions[targetTriage];
  if (!optionId) {
    throw new Error(`Missing Triage option: ${targetTriage}`);
  }

  let projectItem = issue.projectItems.nodes.find(
    (item) =>
      item.project.id === projectConfig.id ||
      (item.project.number === projectNumber && item.project.owner?.login === projectOwner),
  );

  if (!projectItem) {
    // 只有被 assign 的 issue 才进入 project 看板；未分配的留在 issue 列表，
    // 等 assigned 事件触发后再纳入。已在 project 里的 issue 仍随 label/assign 变化同步。
    if (issue.assignees.nodes.length === 0) {
      console.log(`Issue #${issue.number} has no assignee, skip adding to project`);
      return;
    }
    const itemId = await addItemToProject(projectConfig.id, issue.id);
    projectItem = {
      id: itemId,
      fieldValueByName: null,
      statusValue: null,
    };
    console.log(`Added issue #${issue.number} to ${projectConfig.title}`);
  }

  const currentOptionId = projectItem.fieldValueByName?.optionId || "";
  if (currentOptionId !== optionId) {
    await updateTriage({
      projectId: projectConfig.id,
      itemId: projectItem.id,
      fieldId: projectConfig.triageFieldId,
      optionId,
    });
    console.log(`Set issue #${issue.number} triage to ${targetTriage}`);
  } else {
    console.log(`Issue #${issue.number} triage already ${targetTriage}`);
  }

  if (eventAction === "assigned" && issue.state === "OPEN") {
    const targetStatus = "In Progress";
    const statusOptionId = singleSelectOptionId(projectConfig.statusOptions, targetStatus);
    if (!projectConfig.statusFieldId) {
      throw new Error(`Project ${projectConfig.title} is missing a Status field`);
    }
    if (!statusOptionId) {
      throw new Error(`Missing Status option: ${targetStatus}`);
    }

    const currentStatusOptionId = projectItem.statusValue?.optionId || "";
    if (currentStatusOptionId !== statusOptionId) {
      await updateSingleSelectField({
        projectId: projectConfig.id,
        itemId: projectItem.id,
        fieldId: projectConfig.statusFieldId,
        optionId: statusOptionId,
      });
      console.log(`Set issue #${issue.number} status to ${targetStatus}`);
    } else {
      console.log(`Issue #${issue.number} status already ${targetStatus}`);
    }
  }
}

async function fetchOpenIssueNumbers() {
  const numbers = [];
  let cursor = null;
  while (true) {
    const query = `
      query {
        repository(owner: ${gqlString(repoOwner)}, name: ${gqlString(repoName)}) {
          issues(first: 100, after: ${gqlNullableString(cursor)}, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
            nodes {
              number
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `;
    const data = await graphql(query, repoToken);
    const issues = data.repository?.issues;
    if (!issues) break;
    numbers.push(...issues.nodes.map((issue) => issue.number));
    if (!issues.pageInfo.hasNextPage) break;
    cursor = issues.pageInfo.endCursor;
  }
  return numbers;
}

async function main() {
  const projectConfig = await getProjectConfig();
  if (mode === "backfill") {
    const numbers = await fetchOpenIssueNumbers();
    console.log(`Backfilling ${numbers.length} open issues into ${projectConfig.title}`);
    for (const number of numbers) {
      await syncIssue(projectConfig, number);
    }
    return;
  }

  await syncIssue(projectConfig, issueNumber);
}

await main();
