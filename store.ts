// In-memory store for the forge. One process, one store, no disk I/O on requests.
// All timestamps come from a fixed-base logical clock so a replayed run (same requests,
// same order) produces the same commit ids and the same state export.
//
// Ownership: the bearer token names no login by itself. The viewer login is learned from
// the first owner that appears in an authenticated request path (git checks name the owner
// before REST/GraphQL checks do). Repositories created through POST /user/repos belong to
// the viewer; the same name under any other owner is a 404, never a 403.

import {
  buildCommit,
  buildTreeFromFiles,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  ZERO_OID,
  type GitObject,
} from './git.ts';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: { id: number; body: string; seq: number }[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  createdSeq: number;
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function globalId(kind: string, repoId: number, number: number): string {
  return b64url(`${kind}:${repoId}:${number}`);
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
    return { kind: parts[0], repoId, number };
  } catch {
    return null;
  }
}

export class Store {
  viewerLogin: string | null = null;
  repos = new Map<string, Repo>();
  nextRepoId = 1000;
  private clock = 1735689600; // 2025-01-01T00:00:00Z, one second per tick

  tick(): { ts: number; iso: string } {
    const ts = this.clock;
    this.clock += 1;
    return { ts, iso: new Date(ts * 1000).toISOString() };
  }

  /** Learn the viewer login from an owner named in a request path. */
  learnOwner(owner: string): string {
    if (this.viewerLogin === null) this.viewerLogin = owner;
    return this.viewerLogin;
  }

  isViewer(owner: string): boolean {
    if (this.viewerLogin === null) return true;
    return this.viewerLogin === owner;
  }

  /** Resolve a repository by owner+name, learning the viewer when still unknown. */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.viewerLogin === null) {
      // First owner seen: it is the viewer. Adopt repositories created before the
      // viewer was known (POST /user/repos names no owner) into the viewer.
      this.learnOwner(owner);
      for (const r of this.repos.values()) {
        if (r.owner === '') r.owner = this.viewerLogin;
      }
    }
    if (repo.owner !== this.viewerLogin) return null;
    if (owner !== this.viewerLogin) return null;
    return repo;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const owner = this.viewerLogin ?? '';
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      createdSeq: this.clock,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Commits reachable from a ref, newest first (tip, then parents breadth-first by time). */
  listCommits(repo: Repo, from: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [from];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.lookup(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }

  /** Files of a commit (flattened tree). */
  filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = this.lookup(repo, commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return flattenTree(parseCommit(obj.data).tree, (oid) => this.lookup(repo, oid));
  }

  /** Commit a new file tree on a branch. `base` may be null (unborn branch). */
  commitFiles(repo: Repo, branch: string, message: string, files: Map<string, { oid: string; mode: string }>, author: string): string {
    const { rootOid, objects } = buildTreeFromFiles(files);
    for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    const parents: string[] = [];
    const tip = this.branchTip(repo, branch);
    if (tip) parents.push(tip);
    const { ts } = this.tick();
    const commitData = buildCommit(rootOid, parents, message.endsWith('\n') ? message : `${message}\n`, author, ts);
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** Diff between two flattened file maps. */
  static diffFiles(
    before: Map<string, { oid: string; mode: string }>,
    after: Map<string, { oid: string; mode: string }>,
  ): { path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }[] {
    const out: { path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of paths) {
      const b = before.get(path);
      const a = after.get(path);
      if (b && !a) out.push({ path, status: 'removed', additions: 0, deletions: 1 });
      else if (!b && a) out.push({ path, status: 'added', additions: 1, deletions: 0 });
      else if (b && a && b.oid !== a.oid) out.push({ path, status: 'modified', additions: 1, deletions: 1 });
    }
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  /** Nearest common ancestor commit of two tips (first found walking both sides). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set(collectReachable([a], (oid) => this.lookup(repo, oid)));
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) {
        const obj = this.lookup(repo, oid);
        if (obj && obj.type === 'commit') return oid;
      }
      const obj = this.lookup(repo, oid);
      if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /** Would a squash merge of `pull` onto its base conflict? True when the same path was
   * changed on both sides of the merge-base with different resulting content. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return false;
    const base = this.mergeBase(repo, baseTip, headTip);
    if (!base) return false;
    const baseFiles = this.filesAt(repo, base);
    const headFiles = this.filesAt(repo, headTip);
    const currentFiles = this.filesAt(repo, baseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const oldOid = baseFiles.get(path)?.oid ?? null;
      const headOid = headFiles.get(path)?.oid ?? null;
      const curOid = currentFiles.get(path)?.oid ?? null;
      const headChanged = headOid !== oldOid;
      const baseChanged = curOid !== oldOid;
      if (headChanged && baseChanged && headOid !== curOid) return true;
    }
    return false;
  }

  /** Squash-merge an open pull onto its base branch. Returns the merge commit oid, or null
   * when the pull is already closed or the merge conflicts. */
  mergePull(repo: Repo, pull: Pull, author: string): string | null {
    if (pull.state !== 'open') return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return null;
    const headFiles = this.filesAt(repo, headTip);
    const baseFiles = this.filesAt(repo, baseTip);
    const merged = new Map(baseFiles);
    for (const [path, file] of headFiles) merged.set(path, file);
    // Files deleted on the head branch (present at merge-base, absent at head) are removed.
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base) {
      const baseFilesAtMerge = this.filesAt(repo, base);
      for (const path of baseFilesAtMerge.keys()) {
        if (!headFiles.has(path) && baseFiles.has(path)) merged.delete(path);
      }
    }
    const { rootOid, objects } = buildTreeFromFiles(merged);
    for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    const { ts, iso } = this.tick();
    const commitData = buildCommit(rootOid, [baseTip], `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`, author, ts);
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = iso;
    return commitOid;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pulls
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { badLabel: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { badLabel: label };
    }
    const { iso } = this.tick();
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextIssueNumber,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: this.clock,
      comments: [],
      createdAt: iso,
      updatedAt: iso,
    };
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (!headTip || !baseTip) return null;
    const { iso } = this.tick();
    const pull: Pull = {
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      headSha: headTip,
      base,
      baseSha: baseTip,
      seq: this.clock,
      createdAt: iso,
      updatedAt: iso,
    };
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return [];
    const base = this.mergeBase(repo, baseTip, headTip) ?? baseTip;
    const before = this.filesAt(repo, base);
    const after = this.filesAt(repo, headTip);
    return Store.diffFiles(before, after).map((d) => ({
      filename: d.path,
      status: d.status === 'modified' ? 'modified' : d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
    }));
  }
}

export { isOid, ZERO_OID };
