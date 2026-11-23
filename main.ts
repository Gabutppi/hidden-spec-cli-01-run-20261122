// mend — one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, all or nothing.
// Four formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE
// blocks, V4A patches, and text-editor tool calls as JSON. Implements SPEC.md
// v1 of hidden-spec-cli-01-run-20261122. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A usage error: exit 2 with `error: usage`. */
class UsageError extends Error {}

/** A patch-level failure: exit 2 with the line it carries. */
class PatchError extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit's failure: exit 1 with `error: <code> <path>`. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A file's text as lines plus its own line break and whether it ends with one. */
class FileDoc {
  lines: string[];
  br: string;
  final: boolean;
  constructor(text: string) {
    if (text === '') {
      this.lines = [];
      this.br = '\n';
      this.final = false;
      return;
    }
    const nl = text.indexOf('\n');
    this.br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const parts = text.split(this.br);
    if (text.endsWith(this.br)) {
      parts.pop();
      this.final = true;
    } else {
      this.final = false;
    }
    this.lines = parts;
  }
  toString(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.br) + (this.final ? this.br : '');
  }
}

/** The tree as the edits leave it: changed paths in `pending` (null: deleted), the rest read from disk. */
class WorkTree {
  private readonly seen = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }
  get(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.original(p);
  }
  doc(p: string): FileDoc | null {
    const t = this.get(p);
    return t === null ? null : new FileDoc(t);
  }
  put(p: string, doc: FileDoc): void {
    this.pending.set(p, doc.toString());
  }
  putText(p: string, text: string): void {
    this.pending.set(p, text);
  }
  remove(p: string): void {
    this.pending.set(p, null);
  }
}

/** One line of an old/new pair; ctx lines are written as the file's own matched line. */
interface PLine {
  text: string;
  ctx: boolean;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every 0-based position where O matches the file's lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2) at which O occurs at least once; strict tries tier 0 only. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one; eofOnly keeps occurrences ending at the file's last line. */
function findFrom(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; at: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from && (!eofOnly || p + o.length === lines.length));
    if (pos.length > 0) return { tier: t, at: pos[0]! };
  }
  return null;
}

/** First line at or after `from` equal to the anchor, at the first tier with one (single-line match). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** Build the lines that replace O at `at`: context lines come from the file, other lines re-indented at tier 2. */
function buildReplacement(fileLines: string[], at: number, o: PLine[], n: PLine[], tier: number): string[] {
  const ctxFile: string[] = [];
  for (let i = 0; i < o.length; i++) {
    if (o[i]!.ctx) ctxFile.push(fileLines[at + i]!);
  }
  const f = leadWs(fileLines[at] ?? '');
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  const out: string[] = [];
  let ci = 0;
  for (const nl of n) {
    if (nl.ctx) {
      out.push(ctxFile[ci++]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

type Edit = (tree: WorkTree) => void;

/** Detect the patch format (SPEC section 4); null when none holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A unified hunk: its old start line, old/new lines, raw body, and whether a \ line follows its last context or + line. */
interface Hunk {
  start: number;
  oldLines: PLine[];
  newLines: PLine[];
  body: string[];
  noEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
  headerDone: boolean;
}

/** The path after `--- ` or `+++ `: text up to the first tab, surrounding spaces removed. */
function headerPath(s: string): string {
  const tab = s.indexOf('\t');
  return (tab >= 0 ? s.slice(0, tab) : s).trim();
}

/** A leading a/ or b/ is removed from a --- / +++ path. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** True when a \ line follows the last context or + line of this hunk body. */
function hunkNoEol(body: string[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i]!;
    if (l.startsWith(' ') || l.startsWith('+') || l === '') {
      return i + 1 < body.length && body[i + 1]!.startsWith('\\');
    }
  }
  return false;
}

/** True when a \ line follows the section's last + line (for a created file's final break). */
function sectionLastPlusNoEol(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i]!.startsWith('+')) return i + 1 < body.length && body[i + 1]!.startsWith('\\');
    }
  }
  return false;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Parse a unified diff into one edit per section (SPEC section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  const fresh = (): Section => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    createMode: false,
    deleteMode: false,
    hunks: [],
    headerDone: false,
  });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (!m) throw new PatchError(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur === null || cur.headerDone) {
          cur = fresh();
          sections.push(cur);
        }
        cur.oldPath = stripPrefix(headerPath(line.slice(4)));
        cur.newPath = stripPrefix(headerPath(next.slice(4)));
        i += 2;
        continue;
      }
      if (cur !== null && !cur.headerDone) throw new PatchError(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new PatchError(`error: parse ${i + 1}`);
      if (cur === null) throw new PatchError(`error: parse ${i + 1}`);
      cur.headerDone = true;
      const start = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const oldLines: PLine[] = [];
      const newLines: PLine[] = [];
      for (const b of body) {
        if (b.startsWith(' ')) {
          oldLines.push({ text: b.slice(1), ctx: true });
          newLines.push({ text: b.slice(1), ctx: true });
        } else if (b.startsWith('-')) oldLines.push({ text: b.slice(1), ctx: false });
        else if (b.startsWith('+')) newLines.push({ text: b.slice(1), ctx: false });
        else if (b === '') {
          oldLines.push({ text: '', ctx: true });
          newLines.push({ text: '', ctx: true });
        }
      }
      cur.hunks.push({ start, oldLines, newLines, body, noEol: hunkNoEol(body) });
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.createMode = true;
      else if (line.startsWith('deleted file mode')) cur.deleteMode = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's lines; returns the new document. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  let fin = doc.final;
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length > 0) {
      const oText = h.oldLines.map((l) => l.text);
      const found = findTier(lines, oText, strict);
      if (!found) throw new EditFailure('no-match', path);
      const target = h.start - 1 + d;
      let at = found.pos[0]!;
      let best = Math.abs(at - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          at = p;
          best = dist;
        }
      }
      const repl = buildReplacement(lines, at, h.oldLines, h.newLines, found.tier);
      const runsToEnd = at + h.oldLines.length === lines.length;
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + h.oldLines.length)];
      if (runsToEnd) fin = !h.noEol;
      d += h.newLines.length - h.oldLines.length;
    } else {
      const insertAt = Math.max(0, Math.min(h.start + d, lines.length));
      const add = h.newLines.map((l) => l.text);
      // The end-of-file test must use the length before the insertion:
      // after splicing, lines.length is the new length, so comparing
      // insertAt against it would never be true for a non-empty insert.
      const atEnd = insertAt === lines.length;
      lines = [...lines.slice(0, insertAt), ...add, ...lines.slice(insertAt)];
      if (atEnd) fin = !h.noEol;
      d += h.newLines.length;
    }
  }
  const out = new FileDoc('');
  out.lines = lines;
  out.br = doc.br;
  out.final = fin;
  return out;
}

/** One section is one edit: creation, deletion, move or change of one path. */
function sectionEdit(s: Section, strict: boolean): Edit {
  const rawOld = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const rawNew = s.newPath ?? s.renameTo ?? s.gitNew;
  const oldP = rawOld === '/dev/null' ? null : rawOld;
  const newP = rawNew === '/dev/null' ? null : rawNew;
  const isCreate = oldP === null || s.createMode;
  const isDelete = newP === null || s.deleteMode;
  if (isCreate && newP !== null) {
    const np = newP;
    return (tree) => {
      if (!isSafePath(np)) throw new EditFailure('unsafe', np);
      if (tree.get(np) !== null) throw new EditFailure('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.startsWith('+')) plus.push(b.slice(1));
      const noEol = sectionLastPlusNoEol(s.hunks);
      tree.putText(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDelete && oldP !== null) {
    const op = oldP;
    return (tree) => {
      if (!isSafePath(op)) throw new EditFailure('unsafe', op);
      if (tree.get(op) === null) throw new EditFailure('missing', op);
      tree.remove(op);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    const op = oldP;
    const np = newP;
    return (tree) => {
      if (!isSafePath(op)) throw new EditFailure('unsafe', op);
      if (!isSafePath(np)) throw new EditFailure('unsafe', np);
      const doc = tree.doc(op);
      if (doc === null) throw new EditFailure('missing', op);
      if (tree.get(np) !== null) throw new EditFailure('exists', np);
      const out = applyHunks(doc, s.hunks, strict, op);
      tree.putText(np, out.toString());
      tree.remove(op);
      tree.moves.push([op, np]);
    };
  }
  const p = oldP ?? newP;
  if (p === null) return () => {};
  return (tree) => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const doc = tree.doc(p);
    if (doc === null) throw new EditFailure('missing', p);
    tree.put(p, applyHunks(doc, s.hunks, strict, p));
  };
}

/** Parse SEARCH/REPLACE blocks into one edit per block (SPEC section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new PatchError(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new PatchError(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new PatchError(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.putText(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const doc = tree.doc(path);
    if (doc === null) throw new EditFailure('missing', path);
    const found = findTier(doc.lines, oldLines, strict);
    if (!found) throw new EditFailure('no-match', path);
    if (found.pos.length > 1) throw new EditFailure('ambiguous', path);
    const at = found.pos[0]!;
    const o = oldLines.map((t) => ({ text: t, ctx: false }));
    const nn = newLines.map((t) => ({ text: t, ctx: false }));
    const repl = buildReplacement(doc.lines, at, o, nn, found.tier);
    const out = new FileDoc('');
    out.lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + oldLines.length)];
    out.br = doc.br;
    out.final = doc.final;
    tree.put(path, out);
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: PLine[];
  newLines: PLine[];
}

/** Parse a V4A patch into one edit per section (SPEC section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchError('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new PatchError(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new PatchError(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new PatchError(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < end && !isSectionStart(lines[j]!)) j++;
    let secEnd = j;
    while (secEnd > i + 1 && isBlank(lines[secEnd - 1]!)) secEnd--;
    const body = lines.slice(i + 1, secEnd);
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('+') || bl === '') continue;
        throw new PatchError(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(p, body));
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      if (body.length > 0) throw new PatchError(`error: parse ${i + 2}`);
      edits.push(v4aDeleteEdit(p));
    } else {
      const p = line.slice('*** Update File: '.length).trim();
      edits.push(v4aUpdateEdit(p, body, i + 1, strict));
    }
    i = j;
  }
  return edits;
}

function v4aAddEdit(path: string, body: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) !== null) throw new EditFailure('exists', path);
    const fileLines: string[] = [];
    for (const bl of body) fileLines.push(bl.startsWith('+') ? bl.slice(1) : '');
    tree.putText(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.remove(path);
  };
}

function v4aUpdateEdit(path: string, body: string[], updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let chunkCount = 0;
  const lineNo = (k: number): number => updateLineNo + 1 + k;
  for (let k = idx; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('@@')) {
      if (cur !== null) {
        chunks.push(cur);
        chunkCount++;
      }
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oldLines: [], newLines: [] };
    } else if (l === '*** End of File') {
      if (cur === null) throw new PatchError(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      chunks.push(cur);
      chunkCount++;
      cur = null;
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunkCount > 0) throw new PatchError(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, eof: false, oldLines: [], newLines: [] };
      }
      if (l.startsWith(' ')) {
        cur.oldLines.push({ text: l.slice(1), ctx: true });
        cur.newLines.push({ text: l.slice(1), ctx: true });
      } else if (l.startsWith('-')) cur.oldLines.push({ text: l.slice(1), ctx: false });
      else if (l.startsWith('+')) cur.newLines.push({ text: l.slice(1), ctx: false });
      else {
        cur.oldLines.push({ text: '', ctx: true });
        cur.newLines.push({ text: '', ctx: true });
      }
    } else {
      throw new PatchError(`error: parse ${lineNo(k)}`);
    }
  }
  if (cur !== null) {
    chunks.push(cur);
    chunkCount++;
  }
  if (chunks.length === 0 && moveTo === null) throw new PatchError(`error: parse ${updateLineNo}`);
  const target = moveTo;
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (target !== null && !isSafePath(target)) throw new EditFailure('unsafe', target);
    const doc = tree.doc(path);
    if (doc === null) throw new EditFailure('missing', path);
    if (target !== null && tree.get(target) !== null) throw new EditFailure('exists', target);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(lines, ch.anchor, cursor, strict);
        if (ai === null) throw new EditFailure('no-match', path);
        cursor = ai + 1;
      }
      const oText = ch.oldLines.map((l) => l.text);
      if (oText.length > 0) {
        const found = findFrom(lines, oText, cursor, strict, ch.eof);
        if (!found) throw new EditFailure('no-match', path);
        const repl = buildReplacement(lines, found.at, ch.oldLines, ch.newLines, found.tier);
        lines = [...lines.slice(0, found.at), ...repl, ...lines.slice(found.at + oText.length)];
        cursor = found.at + repl.length;
      } else {
        const at = ch.eof ? lines.length : cursor;
        const add = ch.newLines.map((l) => l.text);
        lines = [...lines.slice(0, at), ...add, ...lines.slice(at)];
        cursor = at + add.length;
      }
    }
    const out = new FileDoc('');
    out.lines = lines;
    out.br = doc.br;
    out.final = doc.final;
    if (target !== null) {
      tree.putText(target, out.toString());
      tree.remove(path);
      tree.moves.push([path, target]);
    } else {
      tree.put(path, out);
    }
  };
}

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.putText(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.putText(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const doc = new FileDoc(before);
      if (line < 0 || line > doc.lines.length) throw new EditFailure('no-match', p);
      const next = [...doc.lines];
      next.splice(line, 0, ...add);
      const out = new FileDoc('');
      out.lines = next;
      out.br = doc.br;
      out.final = doc.final;
      tree.put(p, out);
    };
  }
  return null;
}

/** Parse a JSON patch: one array of edit objects, or one edit object per line (SPEC section 9). */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchError('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new PatchError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new PatchError(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new PatchError(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new PatchError(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Parse the patch text in the named format into edits. */
function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return parseJson(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict);
    if (edits.length === 0) throw new PatchError('error: parse 1');
  } catch (e) {
    if (e instanceof PatchError) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const before = new Map(tree.pending);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.pending.clear();
      for (const [k, v] of before) tree.pending.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.pending.keys()) {
    const was = tree.original(p);
    const now = tree.pending.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const moveNew = new Map<string, string>();
  for (const [old, nw] of tree.moves) {
    const o = changed.get(old);
    const n = changed.get(nw);
    if (o && o.was !== null && o.now === null && n && n.was === null && n.now !== null) moveNew.set(nw, old);
  }
  const moveOld = new Set(moveNew.values());
  const rows: Array<{ key: string; line: string }> = [];
  for (const [p, { was, now }] of changed) {
    if (moveNew.has(p) || moveOld.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [nw, old] of moveNew) rows.push({ key: nw, line: `R ${old} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const [p, { now }] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
