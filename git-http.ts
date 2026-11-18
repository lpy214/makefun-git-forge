// Git smart HTTP: info/refs, upload-pack (protocol v2 and v0) and receive-pack (v0).
// Pure protocol framing over the store; no git binary is involved.

import {
  collectReachable,
  decodePkts,
  encodePkts,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { Store, type Repo } from './store.ts';

export interface GitContext {
  store: Store;
  viewer: () => string;
}

const CAPS_V2 = [
  'version 2',
  'agent=makefun-git-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow',
  'server-option',
  'object-format=sha1',
];

const CAPS_V0_UPLOAD =
  'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=makefun-git-forge/1.0 object-format=sha1 multi_ack multi_ack_detailed thin-pack shallow';
const CAPS_V0_RECEIVE =
  'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=makefun-git-forge/1.0 object-format=sha1';

function sidebandPack(pack: Buffer): Buffer {
  // A pkt-line is at most 65520 bytes including its 4-byte length, so a sideband
  // packet (1 band byte + pack bytes) carries at most 65515 pack bytes per chunk.
  const parts: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(off + 65515, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  return Buffer.concat(parts);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs of a repo in advertisement order: HEAD first, then heads, then tags. */
function allRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({
    oid: headTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? CAPS_V0_UPLOAD : CAPS_V0_RECEIVE;
  const refs = allRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0 || !headTip) {
    // Empty repository: one capabilities pseudo-ref line.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (ref.name === 'HEAD') {
        parts.push(pktLine(`${ref.oid} HEAD\0${caps} symref=HEAD:${ref.symrefTarget}\n`));
        return;
      }
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      void index;
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  for (const line of CAPS_V2) parts.push(pktLine(`${line}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleInfoRefs(ctx: GitContext, owner: string, repoName: string, service: string): { status: number; contentType: string; body: Buffer } {
  const repo = ctx.store.findRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  if (service === 'git-upload-pack') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement(repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement('git-receive-pack', repo) };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service', 'utf8') };
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

function objectsForFetch(repo: Repo, wants: string[], haves: Set<string>, depth: number | null, knownShallow: string[] = []): { objects: GitObject[]; shallow: string[]; unshallow: string[]; nothingNew: boolean } {
  // What the client already holds: everything reachable from its haves — except
  // that a have the client knows as a shallow boundary does not carry its parents
  // (a depth-1 clone holds the tip, not its history), so the walk stops there.
  const blocked = new Set<string>();
  for (const s of knownShallow) {
    const obj = repo.objects.get(s);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) blocked.add(p);
    }
  }
  const haveReachable = new Set<string>();
  for (const have of haves) {
    for (const oid of collectReachable([have], (o) => (blocked.has(o) ? undefined : repo.objects.get(o)))) haveReachable.add(oid);
  }
  const included = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    // BFS distance from the wants; include commits with distance < depth. The shallow
    // boundary is the deepest included commit (distance == depth - 1): its parents are
    // cut off. A commit the client already knew as shallow that is now fully included
    // (its parents are in the pack) is reported as unshallow.
    const dist = new Map<string, number>();
    const queue: { oid: string; d: number }[] = wants.map((w) => ({ oid: w, d: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      dist.set(oid, d);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (d >= depth) continue;
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
    }
    const excluded = new Set<string>();
    for (const [oid, d] of dist) {
      if (d === depth - 1) shallow.push(oid);
      if (d >= depth) excluded.add(oid);
    }
    const roots: string[] = [];
    for (const [oid, d] of dist) {
      if (d < depth) roots.push(oid);
    }
    // Reachability must stop at the first excluded generation: a commit at distance
    // == depth is not in the pack, and nothing behind it is either.
    for (const oid of collectReachable(roots, (o) => (excluded.has(o) ? undefined : repo.objects.get(o)))) {
      if (haveReachable.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj) included.set(oid, obj);
    }
    for (const oid of knownShallow) {
      if (roots.includes(oid)) unshallow.push(oid);
    }
    return { objects: [...included.values()], shallow, unshallow, nothingNew: included.size === 0 };
  }
  const reachable = collectReachable(wants, (o) => repo.objects.get(o));
  for (const oid of reachable) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) included.set(oid, obj);
  }
  return { objects: [...included.values()], shallow, unshallow, nothingNew: included.size === 0 };
}

function handleUploadPackV2(ctx: GitContext, repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePkts(body);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      else if (line.startsWith('ref-prefix=')) prefixes.push(line.slice('ref-prefix='.length));
    }
    const out: Buffer[] = [];
    const refs = allRefs(repo);
    const hasRefs = [...repo.refs.values()].length > 0;
    if (!hasRefs && unborn) {
      out.push(pktLine(`${ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (ref.name === 'HEAD' && !hasRefs) continue;
      if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      // Protocol v2 carries the peel as an attribute on the ref's own line
      // (`peeled:<oid>`), not as a separate `^{}` line (that is the v0 form).
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
    out.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(out);
  }
  if (command !== 'command=fetch') {
    return encodePkts(['flush']);
  }
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const { objects, shallow } = objectsForFetch(repo, wants, haves, depth, shallowBoundaries);
  const out: Buffer[] = [];
  // The acknowledgments section only exists when the client negotiated with haves;
  // a fetch with no haves goes straight to shallow-info / packfile (protocol-v2).
  if (haves.size > 0) {
    out.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      const known = repo.objects.has(have);
      if (known) {
        out.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (acked) out.push(pktLine('ready\n'));
    else out.push(pktLine('NAK\n'));
    out.push(Buffer.from('0001', 'ascii'));
  }
  if (shallow.length > 0 || shallowBoundaries.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of shallowBoundaries) {
      // A boundary the client already knew is now fully fetched when it is inside the pack.
      const inPack = objects.some((o) => hashObject(o.type, o.data) === oid);
      if (inPack) out.push(pktLine(`unshallow ${oid}\n`));
    }
    out.push(Buffer.from('0001', 'ascii'));
  }
  if (objects.length > 0 || wants.length > 0) {
    // A fetch always answers with a packfile section, even when it carries zero
    // objects (an empty pack): real git and the suite both expect the section.
    out.push(pktLine('packfile\n'));
    out.push(sidebandPack(writePack(objects)));
  }
  out.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(out);
}

function handleUploadPackV0(ctx: GitContext, repo: Repo, body: Buffer): Buffer {
  void ctx;
  const { packets } = decodePkts(body);
  // v0 request: wants (first section), flush, haves + done (second section).
  const wants: string[] = [];
  const haves = new Set<string>();
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      haves.add(line.slice(5).trim());
    }
  }
  const { objects, shallow } = objectsForFetch(repo, wants, haves, depth);
  const out: Buffer[] = [];
  if (haves.size > 0) {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        out.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) out.push(pktLine('NAK\n'));
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
  // A fetch always answers with a packfile section, even when it carries zero objects.
  out.push(sidebandPack(writePack(objects)));
  out.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(out);
}

export function handleUploadPack(ctx: GitContext, owner: string, repoName: string, body: Buffer, protocolVersion: string | null): { status: number; contentType: string; body: Buffer } {
  const repo = ctx.store.findRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  const result = protocolVersion === 'version=2' ? handleUploadPackV2(ctx, repo, body) : handleUploadPackV0(ctx, repo, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: result };
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

export function handleReceivePack(ctx: GitContext, owner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const repo = ctx.store.findRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  const { packets, rest } = decodePkts(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let newObjects = new Map<string, GitObject>();
  if (rest.length > 0) {
    try {
      newObjects = readPack(rest, (oid) => repo.objects.get(oid));
    } catch {
      unpackOk = false;
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref is at a different commit' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid) ?? newObjects.get(cmd.newOid);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      // Create.
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'remote ref is at a different commit' });
      continue;
    }
    if (cmd.newOid === current) {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // Update: must fast-forward (or be an annotated tag pointing at the same commit line).
    const targetOid = newObj.type === 'tag' ? parseTag(newObj.data).object : cmd.newOid;
    const currentTarget = (() => {
      const cur = repo.objects.get(current);
      return cur && cur.type === 'tag' ? parseTag(cur.data).object : current;
    })();
    if (isAncestor(currentTarget, targetOid, (oid) => repo.objects.get(oid))) {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const r of results) {
    reportLines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  // The report-status stream inside band 1 ends with its own flush packet; without it
  // a real git client reads EOF instead of a flush and reports "remote end hung up".
  reportLines.push(Buffer.from('0000', 'ascii'));
  const report = Buffer.concat(reportLines);
  const out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0000', 'ascii')]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}
