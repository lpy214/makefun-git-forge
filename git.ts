// Git object model, packfiles and pkt-line framing, written for this forge.
// Node standard library only: node:crypto for SHA-1, node:zlib for pack data.
// No git binary is used anywhere; every object is hashed exactly as git does.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(v: string): boolean {
  return HEX40.test(v);
}

function header(type: GitObjectType, len: number): Buffer {
  return Buffer.from(`${type} ${len}\0`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(header(type, data.length));
  h.update(data);
  return h.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'tree') view.tree = v;
    else if (k === 'parent') view.parents.push(v);
    else if (k === 'author') view.author = v;
    else if (k === 'committer') view.committer = v;
  }
  return view;
}

export function buildCommit(tree: string, parents: string[], message: string, author: string, timestamp: number): Buffer {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const view: TagView = { object: '', type: 'commit', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'object') view.object = v;
    else if (k === 'type') view.type = v as GitObjectType;
    else if (k === 'tag') view.tag = v;
    else if (k === 'tagger') view.tagger = v;
  }
  return view;
}

/** Every object reachable from roots: commit -> tree + parents, tree -> entries, tag -> target. */
export function collectReachable(roots: string[], lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of `oid` (or equal)? Used for fast-forward checks. */
export function isAncestor(ancestor: string, oid: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = lookup(cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.parents.includes(ancestor)) return true;
      queue.push(...c.parents);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePkts(items: Array<Buffer | string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(pktFlush());
    else if (it === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Trailing raw bytes (a packfile) are returned separately. */
export function decodePkts(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buf: Buffer, off: number): { size: number; first: number; next: number } {
  let byte = buf[off];
  let size = byte & 0x0f;
  let shift = 4;
  let next = off + 1;
  let first = byte;
  while (byte & 0x80) {
    byte = buf[next];
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, first, next };
}

function readOfsBase(buf: Buffer, off: number): { baseOffset: number; next: number } {
  let byte = buf[off];
  let next = off + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[next];
    next += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off];
      off += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[off] * 2 ** shift;
          off += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[off] * 2 ** shift;
          off += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile, resolving OFS_DELTA and REF_DELTA entries. Thin-pack bases come from lookup. */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const h = readVarintSize(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const b = readOfsBase(pack, off);
      off = b.next;
      entry.baseOffset = entryOffset - b.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    // inflateSync with info returns the whole stream; find its consumed length via a second pass.
    entry.data = inflated.buffer;
    if (entry.data.length !== h.size) throw new Error('pack entry size mismatch');
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) {
      const type = CODE_TYPE[entry.typeCode];
      const oid = hashObject(type, entry.data);
      const obj = { type, data: entry.data };
      objects.set(oid, obj);
      resolvedByOid.set(oid, entry);
      return obj;
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let base: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      base = resolve(baseEntry);
    } else {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) base = resolve(baseEntry);
      else {
        const ext = lookup ? lookup(wanted) : undefined;
        if (!ext) throw new Error('ref-delta base missing');
        base = ext;
      }
    }
    const data = applyDelta(base.data, entry.data);
    const obj = { type: base.type, data };
    const oid = hashObject(obj.type, data);
    objects.set(oid, obj);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

/** Build a tree object for a flat path -> blob map, creating intermediate trees. */
export function buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): { rootOid: string; objects: Map<string, GitObject> } {
  const objects = new Map<string, GitObject>();
  const put = (type: GitObjectType, data: Buffer): string => {
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
    return oid;
  };
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) {
      entries.push({ mode: '40000', name: dir, oid: buildDir(`${prefix}${dir}/`) });
    }
    return put('tree', buildTree(entries));
  };
  return { rootOid: buildDir(''), objects };
}

/** Flatten a tree (at a commit) into path -> {oid, mode}, following nested trees. */
export function flattenTree(rootOid: string, lookup: (oid: string) => GitObject | undefined): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = lookup(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(rootOid, '');
  return out;
}
