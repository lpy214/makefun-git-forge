// The forge's HTTP server: REST v3, GraphQL, MCP and git smart HTTP on one process.
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id; errors are JSON
// with a string `message`. A missing bearer token is 401; a repo under another owner is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Issue, type Pull, type Repo } from './store.ts';
import { buildTreeFromFiles, hashObject } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';

export const store = new Store();

type Json = Record<string, unknown>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], query: URLSearchParams, body: Buffer) => Promise<void> | void;

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = payload === null ? '' : JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': `req-${++requestCounter}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function viewerLogin(): string {
  return store.viewerLogin ?? '';
}

function authorOf(): string {
  const login = viewerLogin() || 'forge';
  return `${login} <${login}@users.noreply.github.com>`;
}

function repoJson(repo: Repo): Json {
  const owner = repo.owner || viewerLogin();
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}:0`, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    html_url: `https://github.com/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${owner}/${repo.name}`,
    created_at: new Date(repo.createdSeq * 1000).toISOString(),
    updated_at: new Date(repo.createdSeq * 1000).toISOString(),
    pushed_at: new Date(repo.createdSeq * 1000).toISOString(),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    language: null,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  const index = [...repo.labels.keys()].indexOf(name);
  return { id: repo.id * 1000 + index + 1, node_id: '', name, color: label?.color ?? 'ededed', default: false, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Json {
  const owner = repo.owner || viewerLogin();
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: owner, id: repo.id, type: 'User' },
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Json {
  const owner = repo.owner || viewerLogin();
  const mergeable = !store.pullConflicts(repo, pull);
  return {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: owner, id: repo.id, type: 'User' },
    labels: [],
    head: { label: `${owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: { login: owner } },
    base: { label: `${owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: { login: owner } },
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[], query: URLSearchParams, basePath: string): T[] {
  const { page, perPage } = parsePage(query);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const links: string[] = [];
  const urlFor = (p: number): string => `${proto}://${host}${basePath}?per_page=${perPage}&page=${p}`;
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (pages > 1) links.push(`<${urlFor(pages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`);
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return slice;
}

function parseJsonBody(body: Buffer): { ok: true; value: Json } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Json };
    if (Array.isArray(value)) return { ok: true, value: { items: value } };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

/** Resolve a ref name or oid to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store.branchTip(repo, repo.defaultBranch);
  const branch = store.branchTip(repo, ref);
  if (branch) return branch;
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  return null;
}

function contentEntry(repo: Repo, path: string, oid: string, isDir: boolean): Json {
  const owner = repo.owner || viewerLogin();
  return {
    type: isDir ? 'dir' : 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    size: isDir ? 0 : (repo.objects.get(oid)?.data.length ?? 0),
    url: `https://api.github.com/repos/${owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

// -------------------------------------------------------------------------------------------
// REST handlers
// -------------------------------------------------------------------------------------------

function handleUserRepos(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, body: Buffer): void {
  if (req.method === 'GET') {
    const items = store.listViewerRepos().map((r) => repoJson(r));
    const page = paginate(req, res, items, query, '/api/v3/user/repos');
    sendJson(res, 200, page);
    return;
  }
  if (req.method === 'POST') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    const name = String(parsed.value.name ?? '');
    if (name === '') {
      sendError(res, 422, 'name is required');
      return;
    }
    const repo = store.createRepo(name, parsed.value.private === true, String(parsed.value.description ?? ''));
    if (!repo) {
      sendError(res, 422, 'Repository already exists');
      return;
    }
    sendJson(res, 201, repoJson(repo));
    return;
  }
  sendError(res, 405, 'method not allowed');
}

function handleRepo(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (req.method === 'PATCH') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
    if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (req.method === 'DELETE') {
    store.deleteRepo(repo);
    res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
    res.end();
    return;
  }
  sendError(res, 405, 'method not allowed');
}

function handleBranches(req: IncomingMessage, res: ServerResponse, owner: string, name: string, rest: string[], query: URLSearchParams): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 0) {
    const list = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false }));
    sendJson(res, 200, list);
    return;
  }
  const branch = rest.join('/');
  const tip = store.branchTip(repo, branch);
  if (!tip) {
    sendError(res, 404, 'Branch not found');
    return;
  }
  sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  void query;
}

function handleCommits(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: URLSearchParams): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const from = resolveRef(repo, query.get('sha'));
  if (!from) {
    sendJson(res, 200, []);
    return;
  }
  const list = store.listCommits(repo, from).map((sha) => {
    const obj = repo.objects.get(sha);
    const view = obj ? parseCommitView(obj.data) : { message: '', parents: [] as string[] };
    return {
      sha,
      commit: {
        message: view.message,
        author: { name: viewerLogin() || 'forge', email: `${viewerLogin() || 'forge'}@users.noreply.github.com`, date: new Date(1735689600000).toISOString() },
        committer: { name: viewerLogin() || 'forge', email: `${viewerLogin() || 'forge'}@users.noreply.github.com`, date: new Date(1735689600000).toISOString() },
      },
      author: { login: viewerLogin() || 'forge' },
      parents: view.parents.map((p) => ({ sha: p })),
      url: `https://api.github.com/repos/${owner}/${name}/commits/${sha}`,
    };
  });
  const page = paginate(req, res, list, query, `/api/v3/repos/${owner}/${name}/commits`);
  sendJson(res, 200, page);
}

function parseCommitView(data: Buffer): { message: string; parents: string[] } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { message: blank < 0 ? '' : text.slice(blank + 2).replace(/\n$/, ''), parents };
}

function handleGitRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, rest: string[], body: Buffer): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (req.method === 'POST' && rest.length === 0) {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    const ref = String(parsed.value.ref ?? '');
    const sha = String(parsed.value.sha ?? '');
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
      sendError(res, 422, 'invalid ref or sha');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    const obj = repo.objects.get(sha);
    sendJson(res, 201, { ref, object: { sha, type: obj?.type ?? 'commit' }, url: `https://api.github.com/repos/${owner}/${name}/git/refs/${ref}` });
    return;
  }
  if (req.method === 'GET') {
    if (rest.length === 0) {
      const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      sendJson(res, 200, list);
      return;
    }
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (!sha) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    return;
  }
  sendError(res, 405, 'method not allowed');
}

function handleContents(req: IncomingMessage, res: ServerResponse, owner: string, name: string, pathParts: string[], query: URLSearchParams, body: Buffer): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const path = pathParts.map((p) => decodeURIComponent(p)).join('/');
  if (req.method === 'GET') {
    const tip = resolveRef(repo, query.get('ref'));
    if (!tip) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const files = store.filesAt(repo, tip);
    if (path === '') {
      const entries: Json[] = [];
      const dirs = new Set<string>();
      for (const [filePath, file] of files) {
        const slash = filePath.indexOf('/');
        if (slash < 0) entries.push(contentEntry(repo, filePath, file.oid, false));
        else dirs.add(filePath.slice(0, slash));
      }
      for (const dir of [...dirs].sort()) entries.push(contentEntry(repo, dir, '', true));
      sendJson(res, 200, entries);
      return;
    }
    const file = files.get(path);
    if (file) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        ...contentEntry(repo, path, file.oid, false),
        encoding: 'base64',
        content: data.toString('base64'),
      });
      return;
    }
    const prefix = `${path}/`;
    const entries: Json[] = [];
    const dirs = new Set<string>();
    for (const [filePath, f] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push(contentEntry(repo, filePath, f.oid, false));
      else dirs.add(rest.slice(0, slash));
    }
    if (entries.length === 0 && dirs.size === 0) {
      sendError(res, 404, 'Not Found');
      return;
    }
    for (const dir of [...dirs].sort()) entries.push(contentEntry(repo, `${path}/${dir}`, '', true));
    sendJson(res, 200, entries);
    return;
  }
  if (req.method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const baseTip = store.branchTip(repo, branch);
    if (baseTip === null && branch !== repo.defaultBranch) {
      sendError(res, 404, 'Branch not found');
      return;
    }
    const files = baseTip ? store.filesAt(repo, baseTip) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    const contentB64 = String(parsed.value.content ?? '').replace(/\s+/g, '');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendError(res, 400, 'content is not valid base64');
      return;
    }
    const blobOid = hashObject('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      if (typeof parsed.value.sha !== 'string' || parsed.value.sha !== existing.oid) {
        sendError(res, 409, 'sha does not match the current file');
        return;
      }
      if (existing.oid === blobOid) {
        const tip = baseTip as string;
        sendJson(res, 200, {
          content: { ...contentEntry(repo, path, blobOid, false), encoding: 'base64' },
          commit: { sha: tip, message: String(parsed.value.message ?? '') },
        });
        return;
      }
    }
    files.set(path, { oid: blobOid, mode: '100644' });
    const message = String(parsed.value.message ?? (isUpdate ? `Update ${path}` : `Create ${path}`));
    const commitOid = store.commitFiles(repo, branch, message, files, authorOf());
    sendJson(res, isUpdate ? 200 : 201, {
      content: { ...contentEntry(repo, path, blobOid, false), encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return;
  }
  if (req.method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const baseTip = store.branchTip(repo, branch);
    if (!baseTip) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const files = store.filesAt(repo, baseTip);
    const existing = files.get(path);
    if (!existing) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.oid) {
      sendError(res, 409, 'sha does not match the current file');
      return;
    }
    files.delete(path);
    const message = String(parsed.value.message ?? `Delete ${path}`);
    const commitOid = store.commitFiles(repo, branch, message, files, authorOf());
    sendJson(res, 200, { commit: { sha: commitOid, message } });
    return;
  }
  sendError(res, 405, 'method not allowed');
}

function handleLabels(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, [...repo.labels.keys()].map((n) => labelJson(repo, n)));
    return;
  }
  if (req.method === 'POST') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    const labelName = String(parsed.value.name ?? '');
    if (labelName === '') {
      sendError(res, 422, 'name is required');
      return;
    }
    if (!repo.labels.has(labelName)) {
      repo.labels.set(labelName, { name: labelName, color: typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed' });
    }
    sendJson(res, 201, labelJson(repo, labelName));
    return;
  }
  sendError(res, 405, 'method not allowed');
}

function handleIssues(req: IncomingMessage, res: ServerResponse, owner: string, name: string, rest: string[], query: URLSearchParams, body: Buffer): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const page = paginate(req, res, list, query, `/api/v3/repos/${owner}/${name}/issues`);
      sendJson(res, 200, page.map((i) => issueJson(repo, i)));
      return;
    }
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      const labels = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).map((l) => String(l)) : [];
      const created = store.createIssue(repo, String(parsed.value.title ?? ''), String(parsed.value.body ?? ''), labels);
      if ('badLabel' in created) {
        sendError(res, 422, `Label does not exist: ${created.badLabel}`);
        return;
      }
      sendJson(res, 201, issueJson(repo, created));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }
  const number = Number(rest[0]);
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (req.method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({
        id: c.id,
        body: c.body,
        user: { login: viewerLogin() || 'forge' },
        created_at: new Date(c.seq * 1000).toISOString(),
        updated_at: new Date(c.seq * 1000).toISOString(),
        html_url: `https://github.com/${owner}/${name}/issues/${number}#issuecomment-${c.id}`,
        url: `https://api.github.com/repos/${owner}/${name}/issues/comments/${c.id}`,
      })));
      return;
    }
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      const comment = { id: repo.nextCommentId, body: String(parsed.value.body ?? ''), seq: store.tick().ts };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: comment.id,
        body: comment.body,
        user: { login: viewerLogin() || 'forge' },
        created_at: new Date(comment.seq * 1000).toISOString(),
        updated_at: new Date(comment.seq * 1000).toISOString(),
        html_url: `https://github.com/${owner}/${name}/issues/${number}#issuecomment-${comment.id}`,
        url: `https://api.github.com/repos/${owner}/${name}/issues/comments/${comment.id}`,
      });
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }
  if (rest.length === 1) {
    if (req.method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      const { iso } = store.tick();
      issue.updatedAt = iso;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handlePulls(req: IncomingMessage, res: ServerResponse, owner: string, name: string, rest: string[], query: URLSearchParams, body: Buffer): void {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const page = paginate(req, res, list, query, `/api/v3/repos/${owner}/${name}/pulls`);
      sendJson(res, 200, page.map((p) => pullJson(repo, p)));
      return;
    }
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      const headRaw = String(parsed.value.head ?? '');
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const baseRaw = String(parsed.value.base ?? '');
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (repo.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) {
        sendError(res, 422, 'A pull request already exists for this branch');
        return;
      }
      const pull = store.createPull(repo, String(parsed.value.title ?? ''), String(parsed.value.body ?? ''), head, base);
      if (!pull) {
        sendError(res, 422, 'head or base branch not found');
        return;
      }
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }
  const number = Number(rest[0]);
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 2 && rest[1] === 'files') {
    sendJson(res, 200, store.pullFiles(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'commits') {
    const headTip = store.branchTip(repo, pull.head);
    const baseTip = store.branchTip(repo, pull.base);
    const baseSet = new Set(baseTip ? store.listCommits(repo, baseTip) : []);
    const list = headTip ? store.listCommits(repo, headTip).filter((sha) => !baseSet.has(sha)) : [];
    sendJson(res, 200, list.map((sha) => {
      const obj = repo.objects.get(sha);
      const view = obj ? parseCommitView(obj.data) : { message: '', parents: [] as string[] };
      return { sha, commit: { message: view.message }, parents: view.parents.map((p) => ({ sha: p })) };
    }));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (req.method !== 'PUT') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (pull.state === 'closed' && pull.merged && pull.mergeCommitSha) {
      sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
      return;
    }
    if (pull.state !== 'open') {
      sendError(res, 405, 'Pull request is closed');
      return;
    }
    if (store.pullConflicts(repo, pull)) {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    const sha = store.mergePull(repo, pull, authorOf());
    if (sha === null) {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
    return;
  }
  if (rest.length === 1) {
    if (req.method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') pull.state = parsed.value.state;
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }
  sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// dispatch
// -------------------------------------------------------------------------------------------

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createForgeServer(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname;
        const query = url.searchParams;
        const body = await readBody(req);
        const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
        if (pathname === '/healthz') {
          sendJson(res, 200, { status: 'ok' });
          return;
        }
        if (!isAuthorized(req)) {
          sendError(res, 401, 'Requires authentication');
          return;
        }
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const suffix = gitMatch[3] as string;
          const ctx = { store, viewer: viewerLogin };
          if (suffix === 'info/refs') {
            const service = query.get('service') ?? '';
            const out = handleInfoRefs(ctx, owner, repoName, service);
            res.writeHead(out.status, { 'content-type': out.contentType, 'x-github-request-id': `req-${++requestCounter}` });
            res.end(out.body);
            return;
          }
          if (suffix === 'upload-pack' || suffix === 'git-upload-pack') {
            const protocol = req.headers['git-protocol'] ?? null;
            const out = handleUploadPack(ctx, owner, repoName, body, protocol);
            res.writeHead(out.status, { 'content-type': out.contentType, 'x-github-request-id': `req-${++requestCounter}` });
            res.end(out.body);
            return;
          }
          if (suffix === 'receive-pack' || suffix === 'git-receive-pack') {
            const out = handleReceivePack(ctx, owner, repoName, body);
            res.writeHead(out.status, { 'content-type': out.contentType, 'x-github-request-id': `req-${++requestCounter}` });
            res.end(out.body);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (pathname === '/api/graphql') {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method not allowed');
            return;
          }
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, 'malformed JSON body');
            return;
          }
          const raw = parsed.value as Json;
          if (Array.isArray((raw as unknown as { items?: unknown }).items)) {
            void raw;
          }
          // Batched operations arrive as a JSON array, which parseJsonBody wraps; re-read raw.
          let ops: Json[];
          try {
            const direct = JSON.parse(body.toString('utf8')) as unknown;
            ops = Array.isArray(direct) ? (direct as Json[]) : [direct as Json];
          } catch {
            sendError(res, 400, 'malformed JSON body');
            return;
          }
          const results = ops.map((op) => {
            const out = executeGraphQL(store, String(op.query ?? ''), (op.variables ?? {}) as Json);
            return out.errors ? { data: out.data, errors: out.errors } : { data: out.data };
          });
          sendJson(res, 200, ops.length === 1 ? results[0] : results);
          return;
        }
        if (pathname === '/mcp') {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method not allowed');
            return;
          }
          let parsedBody: unknown;
          try {
            parsedBody = body.length === 0 ? null : JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const out = handleMcp(store, parsedBody);
          sendJson(res, out.status, out.body);
          return;
        }
        if (pathname === '/api/v3/' || pathname === '/api/v3') {
          sendJson(res, 200, {
            current_user_url: 'https://api.github.com/user',
            repository_url: 'https://api.github.com/repos/{owner}/{repo}',
            user_url: 'https://api.github.com/users/{user}',
          }, { 'x-oauth-scopes': 'repo, user' });
          return;
        }
        if (pathname === '/api/v3/meta') {
          sendJson(res, 200, {
            verifiable_password_authentication: false,
            installed_version: '1.0.0',
            hooks: [],
            git: [],
            pages: [],
            importer: [],
            api: [],
            github_enterprise_importer: [],
          });
          return;
        }
        if (pathname === '/api/v3/user') {
          const login = viewerLogin();
          sendJson(res, 200, { login, id: 1000, node_id: '', type: 'User', site_admin: false });
          return;
        }
        if (pathname === '/api/v3/user/repos') {
          handleUserRepos(req, res, query, body);
          return;
        }
        const repoMatch = pathname.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
        if (repoMatch) {
          const owner = decodeURIComponent(repoMatch[1] as string);
          const name = decodeURIComponent(repoMatch[2] as string);
          const restPath = repoMatch[3] ?? '';
          const rest = restPath === '' ? [] : restPath.split('/');
          if (rest.length === 0) {
            handleRepo(req, res, owner, name, body);
            return;
          }
          if (rest[0] === 'branches') {
            handleBranches(req, res, owner, name, rest.slice(1), query);
            return;
          }
          if (rest[0] === 'commits') {
            handleCommits(req, res, owner, name, query);
            return;
          }
          if (rest[0] === 'git' && rest[1] === 'refs') {
            handleGitRefs(req, res, owner, name, rest.slice(2), body);
            return;
          }
          if (rest[0] === 'contents') {
            handleContents(req, res, owner, name, rest.slice(1), query, body);
            return;
          }
          if (rest[0] === 'labels') {
            handleLabels(req, res, owner, name, body);
            return;
          }
          if (rest[0] === 'issues') {
            handleIssues(req, res, owner, name, rest.slice(1), query, body);
            return;
          }
          if (rest[0] === 'pulls') {
            handlePulls(req, res, owner, name, rest.slice(1), query, body);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        sendError(res, 404, 'Not Found');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendError(res, 500, message);
        else res.end();
      }
    })();
  });
  return server;
}
