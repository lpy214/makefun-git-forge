# makefun-git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/c/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lpy214/makefun-git-forge/rank.svg)](https://make.fun/c/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lpy214/makefun-git-forge/reward.svg)](https://make.fun/c/github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process — built from scratch for the
[make.fun](https://make.fun/c/github-core-clone-01) bounty **github-core-clone-01**.
No dependencies, no git binary, no outside services: just Node 22 and the standard library.

## What it does

- **Git smart HTTP** at `/{owner}/{repo}.git` — `upload-pack` protocol v2 (ls-refs, fetch,
  shallow/deepen) and `receive-pack` v0 with `report-status`, `side-band-64k` and
  `delete-refs`. Fast-forward-only pushes; non-fast-forward refs are refused per ref.
  SHA-1 objects, PACK v2, pkt-line framing — plain objects on the wire, delta packs read
  on the way in.
- **REST v3** at `/api/v3` — repos, branches, commits, contents (base64, with sha
  conflict detection), labels, issues, comments and pull requests with squash merge and
  conflict detection, plus pagination, `X-GitHub-Request-Id` on every reply and JSON
  error bodies everywhere.
- **GraphQL** at `/api/graphql` — viewer, repository, issues/pull requests with cursor
  pagination, mutations (create/close issue, create/merge PR, add comment), node(id:)
  round-trips and opaque global IDs.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, protocol revision `2026-07-28`
  (`server/discover`) with the legacy handshake, six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on
  the same store as REST.
- **One store, deterministic replay** — a fixed logical clock and content-addressed
  objects mean the same operations always produce the same commits and the same state
  export.

## Run it

```sh
# Node 22 required
MAKEFUN_ENV_URL=http://127.0.0.1:PORT   # the harness registers here; unset => exit 1
MAKEFUN_SHOP_TOKEN=<token>              # bearer token for git / REST / GraphQL / MCP
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, then
polls `$MAKEFUN_ENV_URL/done` until the trial ends and exits 0.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Process lifecycle (bind, register, wait, exit) |
| `app.ts` | HTTP server, auth, REST v3, GraphQL and MCP dispatch |
| `store.ts` | In-memory model: repos, refs, issues, PRs, labels, deterministic clock |
| `git.ts` | SHA-1 objects, trees/commits/tags, pkt-line, PACK v2 read/write |
| `git-http.ts` | Git smart HTTP: info/refs, upload-pack v0/v2, receive-pack v0 |
| `graphql.ts` | GraphQL dispatcher over query text |
| `mcp.ts` | MCP handler: discover, initialize, tools/list, tools/call |

## License

MIT — see [LICENSE](LICENSE).
