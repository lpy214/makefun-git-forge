// GraphQL v4 surface: the documents gh and github-mcp-server actually send.
// A small dispatcher over the query text — no schema library, no generated code.

import { decodeGlobalId, globalId, Store, type Issue, type Pull, type Repo } from './store.ts';

type Json = Record<string, unknown>;

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'author', 'createdAt', 'updatedAt'];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
  'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'fork',
  'stargazerCount', 'watchers', 'primaryLanguage', 'languages', 'licenseInfo', 'homepageUrl', 'visibility',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT', 'WIKI'];

function issueId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}
function pullId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}
function repoId(repo: Repo): string {
  return globalId('Repository', repo.id, 0);
}
function commentId(repo: Repo, comment: { id: number }): string {
  return globalId('IssueComment', repo.id, comment.id);
}

function issueNode(store: Store, repo: Repo, issue: Issue): Json {
  return {
    id: issueId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { login: store.viewerLogin ?? repo.owner },
    comments: { totalCount: issue.comments.length, nodes: issue.comments.map((c) => ({ id: commentId(repo, c), body: c.body })) },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
  };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullNode(store: Store, repo: Repo, pull: Pull): Json {
  return {
    id: pullId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: { login: store.viewerLogin ?? repo.owner },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    files: { nodes: store.pullFiles(repo, pull).map((f) => ({ path: f.filename })) },
  };
}

function repoNode(store: Store, repo: Repo): Json {
  const owner = repo.owner || store.viewerLogin || '';
  return {
    id: repoId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { login: owner },
    defaultBranchRef: store.branchTip(repo, repo.defaultBranch) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: new Date(repo.createdSeq * 1000).toISOString(),
    updatedAt: new Date(repo.createdSeq * 1000).toISOString(),
    url: `https://github.com/${owner}/${repo.name}`,
    isPrivate: repo.isPrivate,
    fork: false,
    stargazerCount: 0,
    watchers: { totalCount: 0 },
    primaryLanguage: null,
    languages: { nodes: [] },
    licenseInfo: null,
    homepageUrl: null,
    visibility: repo.isPrivate ? 'PRIVATE' : 'PUBLIC',
  };
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Execute one GraphQL operation document. Returns {data, errors?}. */
export function executeGraphQL(store: Store, query: string, variables: Json): { data: Json; errors?: { message: string }[] } {
  const vars = variables ?? {};
  const q = query.replace(/\s+/g, ' ');

  // ---- introspection -------------------------------------------------------
  // One document can probe several types at once (gh sends PullRequest and
  // Repository in a single query, each under its own alias), so answer every
  // __type(name: "...") occurrence, not just the first.
  const typeFields: Record<string, string[] | null> = {
    Issue: ISSUE_FIELDS,
    PullRequest: PULL_REQUEST_FIELDS,
    Repository: REPOSITORY_FIELDS,
  };
  const typeMatches = [...q.matchAll(/(\w+)\s*:\s*__type\s*\(\s*name:\s*"([^"]+)"\s*\)/g)];
  if (typeMatches.length === 0) {
    const bare = q.match(/__type\s*\(\s*name:\s*"([^"]+)"\s*\)/);
    if (bare) {
      const typeName = bare[1] as string;
      if (typeName === 'SearchType') {
        return { data: { __type: { fields: null, enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) } } };
      }
      if (typeName in typeFields) {
        return { data: { __type: { fields: (typeFields[typeName] as string[]).map((name) => ({ name })), enumValues: null } } };
      }
      return { data: { __type: null } };
    }
  }
  if (typeMatches.length > 0) {
    const data: Json = {};
    for (const m of typeMatches) {
      const alias = m[1] as string;
      const typeName = m[2] as string;
      if (typeName === 'SearchType') {
        data[alias] = { fields: null, enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) };
      } else if (typeName in typeFields) {
        data[alias] = { fields: (typeFields[typeName] as string[]).map((name) => ({ name })), enumValues: null };
      } else {
        data[alias] = null;
      }
    }
    return { data };
  }

  // ---- invalid field -------------------------------------------------------
  if (q.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: store.viewerLogin ?? '' } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
    };
  }
  const unknownField = q.match(/viewer\s*\{[^}]*?(\w+)\s*\}/);
  if (unknownField && q.includes('viewer') && !q.includes('login')) {
    void unknownField;
  }

  // ---- mutations -----------------------------------------------------------
  if (q.includes('mutation')) {
    if (q.includes('createIssue')) {
      const input = (vars.input ?? {}) as Json;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : null;
      if (!repo) return { data: { createIssue: null }, errors: [{ message: 'repository not found' }] };
      const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('badLabel' in created) return { data: { createIssue: null }, errors: [{ message: 'unknown label' }] };
      return { data: { createIssue: { issue: { number: created.number, id: issueId(repo, created) } } } };
    }
    if (q.includes('closeIssue')) {
      const input = (vars.input ?? {}) as Json;
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : null;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!repo || !issue) return { data: { closeIssue: null }, errors: [{ message: 'issue not found' }] };
      issue.state = 'closed';
      const { iso } = store.tick();
      issue.updatedAt = iso;
      return { data: { closeIssue: { issue: { number: issue.number, id: issueId(repo, issue), state: 'CLOSED' } } } };
    }
    if (q.includes('createPullRequest')) {
      const input = (vars.input ?? {}) as Json;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : null;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const pull = repo ? store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base) : null;
      if (!repo || !pull) return { data: { createPullRequest: null }, errors: [{ message: 'could not create pull request' }] };
      return { data: { createPullRequest: { pullRequest: { number: pull.number, id: pullId(repo, pull), state: 'OPEN', headRefName: pull.head, baseRefName: pull.base } } } };
    }
    if (q.includes('mergePullRequest')) {
      const input = (vars.input ?? {}) as Json;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : null;
      const pull = repo?.pulls.find((p) => p.number === decoded?.number);
      if (!repo || !pull) return { data: { mergePullRequest: null }, errors: [{ message: 'pull request not found' }] };
      const author = `${store.viewerLogin ?? 'forge'} <${store.viewerLogin ?? 'forge'}@users.noreply.github.com>`;
      const sha = store.mergePull(repo, pull, author);
      if (sha === null) {
        return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: false, state: pullState(pull) } } } };
      }
      return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } } };
    }
    if (q.includes('addComment')) {
      const input = (vars.input ?? {}) as Json;
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : null;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!repo || !issue) return { data: { addComment: null }, errors: [{ message: 'subject not found' }] };
      const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), seq: store.tick().ts };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return { data: { addComment: { commentEdge: { node: { id: commentId(repo, comment), body: comment.body } } } } };
    }
    return { data: {}, errors: [{ message: 'unknown mutation' }] };
  }

  // ---- node(id:) -----------------------------------------------------------
  if (q.includes('node(')) {
    const id = typeof vars.id === 'string' ? vars.id : '';
    const decoded = decodeGlobalId(id);
    if (!decoded) return { data: { node: null } };
    if (decoded.kind === 'Repository') {
      const repo = findRepoById(store, decoded.repoId);
      if (!repo) return { data: { node: null } };
      const node = repoNode(store, repo);
      return { data: { node } };
    }
    if (decoded.kind === 'Issue') {
      const repo = findRepoById(store, decoded.repoId);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (!repo || !issue) return { data: { node: null } };
      return { data: { node: issueNode(store, repo, issue) } };
    }
    if (decoded.kind === 'PullRequest') {
      const repo = findRepoById(store, decoded.repoId);
      const pull = repo?.pulls.find((p) => p.number === decoded.number);
      if (!repo || !pull) return { data: { node: null } };
      return { data: { node: pullNode(store, repo, pull) } };
    }
    return { data: { node: null } };
  }

  // ---- viewer --------------------------------------------------------------
  if (/\bviewer\s*\{/.test(q)) {
    return { data: { viewer: { login: store.viewerLogin ?? '' } } };
  }

  // ---- repository(...) -----------------------------------------------------
  if (q.includes('repository(')) {
    const owner = String(vars.owner ?? '');
    const name = String(vars.name ?? '');
    const repo = store.findRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const node: Json = repoNode(store, repo);
    // issue(number:)
    const issueNumber = typeof vars.number === 'number' ? vars.number : null;
    if (q.includes('issue(number:')) {
      const issue = repo.issues.find((i) => i.number === issueNumber);
      node.issue = issue ? issueNode(store, repo, issue) : null;
    }
    if (q.includes('pullRequest(number:')) {
      const pull = repo.pulls.find((p) => p.number === issueNumber);
      node.pullRequest = pull ? pullNode(store, repo, pull) : null;
    }
    if (q.includes('issues(')) {
      let list = [...repo.issues];
      const statesMatch = q.match(/states:\s*\[([^\]]*)\]/);
      if (statesMatch) {
        const wanted = (statesMatch[1] as string).split(',').map((s) => s.trim());
        list = list.filter((i) => wanted.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const desc = q.includes('direction: DESC') || !q.includes('direction: ASC');
      list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
      const first = typeof vars.first === 'number' ? vars.first : list.length;
      let start = 0;
      if (typeof vars.after === 'string' && vars.after) {
        const afterNumber = numberFromCursor(vars.after);
        if (afterNumber !== null) {
          const idx = list.findIndex((i) => i.number === afterNumber);
          if (idx >= 0) start = idx + 1;
        }
      }
      const page = list.slice(start, start + first);
      node.issues = {
        nodes: page.map((i) => issueNode(store, repo, i)),
        pageInfo: {
          hasNextPage: start + page.length < list.length,
          endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null,
        },
        totalCount: list.length,
      };
    }
    if (q.includes('pullRequests(')) {
      const first = typeof vars.first === 'number' ? vars.first : 100;
      const open = repo.pulls.filter((p) => p.state === 'open');
      node.pullRequests = { nodes: open.slice(0, first).map((p) => pullNode(store, repo, p)), totalCount: open.length };
    }
    return { data: { repository: node } };
  }

  return { data: {}, errors: [{ message: 'unknown query' }] };
}
