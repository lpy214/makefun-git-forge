// MCP endpoint: JSON-RPC 2.0 Streamable HTTP at /mcp.
// Supports the modern 2026-07-28 revision (server/discover, no handshake) and the legacy
// 2025-11-25-and-earlier handshake (initialize + notifications/initialized).

import { Store, type Repo } from './store.ts';

type Json = Record<string, unknown>;

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(id: unknown, payload: unknown, isError = false): Json {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text }], structuredContent: payload, isError },
  };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function repoJson(store: Store, repo: Repo): Json {
  const owner = repo.owner || store.viewerLogin || '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${owner}/${repo.name}`,
  };
}

function missingArg(args: Json, required: string[]): string | null {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

export function handleMcp(store: Store, body: unknown): { status: number; body: Json } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Json;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id ?? null;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: SUPPORTED_VERSIONS,
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        },
      },
    };
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Json;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Json;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Json;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { status: 200, body: rpcError(id, -32602, `unknown tool: ${name}`) };
    const missing = missingArg(args, tool.inputSchema.required);
    if (missing) {
      return { status: 200, body: toolResult(id, { error: `missing required argument: ${missing}` }, true) };
    }
    if (name === 'create_repo') {
      const repo = store.createRepo(String(args.name), args.private === true, String(args.description ?? ''));
      if (!repo) return { status: 200, body: toolResult(id, { error: `repository ${String(args.name)} already exists` }, true) };
      return { status: 200, body: toolResult(id, repoJson(store, repo)) };
    }
    if (name === 'get_repo') {
      const repo = store.findRepo(String(args.owner), String(args.repo));
      if (!repo) return { status: 200, body: toolResult(id, { error: 'repository not found' }, true) };
      return { status: 200, body: toolResult(id, repoJson(store, repo)) };
    }
    if (name === 'create_issue') {
      const repo = store.findRepo(String(args.owner), String(args.repo));
      if (!repo) return { status: 200, body: toolResult(id, { error: 'repository not found' }, true) };
      const created = store.createIssue(repo, String(args.title), String(args.body ?? ''), []);
      if ('badLabel' in created) return { status: 200, body: toolResult(id, { error: 'unknown label' }, true) };
      return {
        status: 200,
        body: toolResult(id, {
          id: created.id,
          number: created.number,
          title: created.title,
          body: created.body,
          state: created.state,
        }),
      };
    }
    if (name === 'list_issues') {
      const repo = store.findRepo(String(args.owner), String(args.repo));
      if (!repo) return { status: 200, body: toolResult(id, { error: 'repository not found' }, true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return {
        status: 200,
        body: toolResult(id, list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }))),
      };
    }
    if (name === 'create_pull_request') {
      const repo = store.findRepo(String(args.owner), String(args.repo));
      if (!repo) return { status: 200, body: toolResult(id, { error: 'repository not found' }, true) };
      const pull = store.createPull(repo, String(args.title), String(args.body ?? ''), String(args.head), String(args.base));
      if (!pull) return { status: 200, body: toolResult(id, { error: 'could not create pull request' }, true) };
      return {
        status: 200,
        body: toolResult(id, {
          number: pull.number,
          title: pull.title,
          state: pull.state,
          head: { ref: pull.head, sha: pull.headSha },
          base: { ref: pull.base, sha: pull.baseSha },
        }),
      };
    }
    if (name === 'merge_pull_request') {
      const repo = store.findRepo(String(args.owner), String(args.repo));
      if (!repo) return { status: 200, body: toolResult(id, { error: 'repository not found' }, true) };
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return { status: 200, body: toolResult(id, { error: 'pull request not found' }, true) };
      const author = `${store.viewerLogin ?? 'forge'} <${store.viewerLogin ?? 'forge'}@users.noreply.github.com>`;
      const sha = store.mergePull(repo, pull, author);
      if (sha === null) return { status: 200, body: toolResult(id, { error: 'pull request cannot be merged' }, true) };
      return { status: 200, body: toolResult(id, { sha, merged: true, message: `Merge pull request #${pull.number}` }) };
    }
    return { status: 200, body: rpcError(id, -32602, `unknown tool: ${name}`) };
  }
  return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
}
