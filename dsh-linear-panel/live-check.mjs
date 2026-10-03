#!/usr/bin/env node
/**
 * Live gate for @local/dsh-linear: runs every query and mutation signature the
 * panel uses against the real Linear API through the local proxy, and fails on
 * any GraphQL validation/classification error (the class of bug that surfaces
 * as "Variable ... used in position expecting type ..." in the UI).
 *
 * Mutations run only against a non-existent issue id, so nothing is written;
 * a validation error there fails the gate, an entity-not-found passes it.
 */
const ENDPOINT = process.env.LINEAR_PROXY ?? 'http://127.0.0.1:3081/dsh-linear';
const FAKE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'; // well-formed, non-existent

// Schema-level problems: the class of bug that breaks the panel.
const SCHEMA_ERROR = /expecting type|Unknown argument|Unknown field|Unknown variable|never used|doesn't accept|Coercing|Required (parameter|argument)|got invalid value|GRAPHQL_VALIDATION_FAILED|GRAPHQL_PARSE_FAILED/i;

let failures = 0;
const ok = (msg) => console.log(`ok: ${msg}`);
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures = 1; };

async function gql(label, query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => null);
  const errors = data?.errors ?? [];
  const schema = errors.filter((e) => SCHEMA_ERROR.test(e.message) || e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED');
  if (schema.length) {
    fail(`${label}: schema error: ${schema.map((e) => e.message).join(' | ')}`);
    return null;
  }
  if (errors.length) {
    // On a fake id, runtime entity/argument errors prove the signature is valid.
    ok(`${label}: signature accepted (server: ${errors[0].message})`);
    return null;
  }
  if (!res.ok) { fail(`${label}: HTTP ${res.status}`); return null; }
  ok(label);
  return data.data;
}

const ISSUE_NODES = `{
  nodes { id identifier title url priority parent { id identifier }
    assignee { name } state { id name type } team { key name } updatedAt
    children { nodes { id state { type } } } } }`;

const Q = {
  teams: `{ teams { nodes { id key name } } }`,
  viewer: `{ viewer { id name } }`,
  org: `{ organization { urlKey } }`,
  states: `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
  detail: `query($id: String!) {
    issue(id: $id) {
      id identifier title description url priority
      state { id name type } team { id key name }
      assignee { id name }
      parent { id identifier title }
      children { nodes { id identifier title state { id name type } assignee { name } } }
      labels { nodes { id name } }
      comments(first: 50, orderBy: createdAt) { nodes { id body user { name } createdAt } }
      createdAt updatedAt
    }
  }`,
  setState: `mutation($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { id name type } } } }`,
  setPriority: `mutation($id: String!, $priority: Int!) {
    issueUpdate(id: $id, input: { priority: $priority }) { success issue { id priority } } }`,
  setAssignee: `mutation($id: String!, $assigneeId: String) {
    issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success issue { id assignee { id name } } } }`,
  addComment: `mutation($id: String!, $body: String!) {
    commentCreate(input: { issueId: $id, body: $body }) { success comment { id body user { name } createdAt } } }`,
};

// Mirror of the client's listQuery — this gate must exercise what ships.
function listQuery(search, teamId) {
  if (search) {
    const team = teamId ? 'teamId: $teamId,' : '';
    const decl = teamId ? '($teamId: String!, $term: String!)' : '($term: String!)';
    const variables = { term: search };
    if (teamId) variables.teamId = teamId;
    return [`query${decl} {
      searchIssues(term: $term, ${team} first: 50, orderBy: updatedAt) ${ISSUE_NODES}
    }`, variables];
  }
  const parts = ['parent: { null: true }'];
  if (teamId) parts.push('team: { id: { eq: $teamId } }');
  const decl = teamId ? '($teamId: ID)' : '';
  return [`query${decl} {
    issues(filter: { ${parts.join(', ')} }, first: 50, orderBy: updatedAt) ${ISSUE_NODES}
  }`, teamId ? { teamId } : {}];
}

const [teamsData, viewerData, orgData] = await Promise.all([
  gql('teams', Q.teams),
  gql('viewer', Q.viewer),
  gql('organization urlKey', Q.org),
]);
orgData?.organization?.urlKey ? ok(`issue links base: https://linear.app/${orgData.organization.urlKey}`) : fail('organization urlKey missing');
const teamId = teamsData?.teams?.nodes?.[0]?.id;
if (!teamId) fail('no team id — cannot exercise team-scoped queries');

const [statesData] = await Promise.all([
  teamId ? gql('states(teamId: String!)', Q.states, { teamId }) : Promise.resolve(null),
  teamId ? (async () => { const [q, v] = listQuery('', teamId); return gql('issues (team filter: ID)', q, v); })() : Promise.resolve(null),
  gql('searchIssues (no team)', ...listQuery('the', '')),
  teamId ? (async () => { const [q, v] = listQuery('the', teamId); return gql('searchIssues + team filter', q, v); })() : Promise.resolve(null),
]);

let issueId;
if (teamId && statesData) {
  const stateNodes = statesData.team?.states?.nodes ?? [];
  stateNodes.length ? ok(`states returned ${stateNodes.length}`) : fail('states returned none');
}

const listData = await gql('issues (no team filter) rerun', ...listQuery('', ''));
issueId = listData?.issues?.nodes?.[0]?.id;
if (issueId) {
  const detail = await gql('issue detail', Q.detail, { id: issueId });
  if (detail?.issue?.identifier) ok(`detail loaded ${detail.issue.identifier}`);
} else {
  fail('no issues returned — detail query untested');
}

// Parent/sub-issue relation: the browse list must contain no child issues, and
// a child reached from its parent must report that same parent back.
const nodes = listData?.issues?.nodes ?? [];
nodes.every((n) => n.parent === null)
  ? ok(`browse list is parentless (${nodes.length} issues)`)
  : fail('browse list contains sub-issues');
const withKids = nodes.find((n) => (n.children?.nodes ?? []).length > 0);
if (withKids) {
  ok(`parent row carries children (${withKids.identifier}: ${withKids.children.nodes.length})`);
  const childDetail = await gql('child detail', Q.detail, { id: withKids.children.nodes[0].id });
  childDetail?.issue?.parent?.identifier === withKids.identifier
    ? ok(`child ${childDetail.issue.identifier} reports parent ${withKids.identifier}`)
    : fail(`child parent link (got ${JSON.stringify(childDetail?.issue?.parent ?? null)})`);
} else {
  fail('no issue with children — parent/sub-issue relation untested');
}

// Mutation signatures against a non-existent id: entity errors pass, validation fails.
await gql('issueUpdate stateId signature', Q.setState, { id: FAKE_ID, stateId: FAKE_ID });
await gql('issueUpdate priority signature', Q.setPriority, { id: FAKE_ID, priority: 0 });
await gql('issueUpdate assigneeId signature', Q.setAssignee, { id: FAKE_ID, assigneeId: null });
await gql('commentCreate signature', Q.addComment, { id: FAKE_ID, body: 'gate' });

process.exit(failures);
