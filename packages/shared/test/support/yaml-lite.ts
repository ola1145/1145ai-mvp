/**
 * Dependency-free YAML subset parser for contract tests (we may not add a YAML dependency).
 * Supports what contracts/openapi/*.yaml uses: block mappings and sequences, flow mappings/sequences
 * (also spanning lines), single/double-quoted and plain scalars, literal/folded block scalars, comments.
 * Not supported (throws or is out of scope): anchors/aliases, tags, multi-document streams, multi-line plain scalars.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export class YamlError extends Error {
  constructor(message: string, line?: number) { super(line === undefined ? message : `line ${line}: ${message}`); }
}

interface Line { indent: number; text: string; no: number; raw: string }

/** Remove a trailing ` # comment` that is outside quotes. */
function stripComment(s: string): string {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue; }
        q = null;
      }
    } else if (c === '"' || c === "'") {
      // A quote only opens a quoted scalar at a token start.
      const prev = s.slice(0, i).trimEnd().slice(-1);
      if (i === 0 || prev === '' || ':-,[{'.includes(prev)) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function resolvePlain(s: string): YamlValue {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)$/.test(t)) return Number(t);
  if (/^-?(?:0|[1-9]\d*)\.\d+(?:[eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Flow-context parser over a single (possibly joined) string. */
class Flow {
  i = 0;
  constructor(private s: string, private no: number) {}
  private ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++; }
  private err(m: string): never { throw new YamlError(`${m} at col ${this.i + 1} in "${this.s}"`, this.no); }

  value(): YamlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    if (c === '"' || c === "'") return this.quoted();
    return resolvePlain(this.plain(false));
  }

  quoted(): string {
    const q = this.s[this.i]!;
    let j = this.i + 1; let out = '';
    for (;;) {
      if (j >= this.s.length) this.err('unterminated quoted scalar');
      const c = this.s[j]!;
      if (q === "'" && c === "'") {
        if (this.s[j + 1] === "'") { out += "'"; j += 2; continue; }
        break;
      }
      if (q === '"' && c === '\\') { out += c + (this.s[j + 1] ?? ''); j += 2; continue; }
      if (q === '"' && c === '"') break;
      out += c; j++;
    }
    this.i = j + 1;
    if (q === '"') {
      try { return JSON.parse(`"${out.replace(/\\'/g, "'")}"`) as string; } catch { this.err('bad escape in double-quoted scalar'); }
    }
    return out;
  }

  /** Plain scalar in flow context: stops at , ] } (and at ": " / ":" + flow indicator when it is a key). */
  plain(isKey: boolean): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === ',' || c === ']' || c === '}') break;
      if (isKey && c === ':' && (this.i + 1 >= this.s.length || /[\s,\[\]{}]/.test(this.s[this.i + 1]!))) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }

  map(): { [k: string]: YamlValue } {
    const out: { [k: string]: YamlValue } = {};
    this.i++; // {
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return out; }
      if (this.i >= this.s.length) this.err('unterminated flow mapping');
      const c = this.s[this.i];
      const key = c === '"' || c === "'" ? this.quoted() : this.plain(true);
      this.ws();
      let val: YamlValue = null;
      if (this.s[this.i] === ':') { this.i++; this.ws(); val = this.s[this.i] === ',' || this.s[this.i] === '}' ? null : this.value(); }
      if (Object.prototype.hasOwnProperty.call(out, key)) this.err(`duplicate key "${key}"`);
      out[key] = val;
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; return out; }
      this.err('expected , or } in flow mapping');
    }
  }

  seq(): YamlValue[] {
    const out: YamlValue[] = [];
    this.i++; // [
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return out; }
      if (this.i >= this.s.length) this.err('unterminated flow sequence');
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; return out; }
      this.err('expected , or ] in flow sequence');
    }
  }

  done() { this.ws(); if (this.i < this.s.length) this.err('trailing content'); }
}

/** Bracket balance outside quotes, used to join a flow collection that spans lines. */
function flowDepth(s: string): number {
  let d = 0; let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; }
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s,\[{:]/.test(s[i - 1]!))) q = c;
    else if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') d--;
  }
  return d;
}

/** Split "key: rest" in block context. Returns undefined if the line is not a mapping entry. */
function splitKey(text: string, no: number): { key: string; rest: string } | undefined {
  if (text[0] === '"' || text[0] === "'") {
    const f = new Flow(text, no);
    const key = f.quoted();
    const after = text.slice(f.i);
    const m = /^\s*:(?:\s+|$)/.exec(after);
    if (!m) return undefined;
    return { key, rest: after.slice(m[0].length).trim() };
  }
  if (text[0] === '{' || text[0] === '[') return undefined;
  const m = /:(?:\s+|$)/.exec(text);
  if (!m) return undefined;
  return { key: text.slice(0, m.index).trim(), rest: text.slice(m.index + m[0].length).trim() };
}

export function parseYaml(src: string): YamlValue {
  const lines: Line[] = src.replace(/\r\n/g, '\n').split('\n').map((raw, idx) => {
    if (/^\s*\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const indent = raw.length - raw.trimStart().length;
    return { indent, text: stripComment(raw.trimStart()).trimEnd(), no: idx + 1, raw };
  });
  let p = 0;
  const skipBlank = () => { while (p < lines.length && lines[p]!.text === '') p++; };

  function inline(rest: string, line: Line): YamlValue {
    if (rest[0] === '{' || rest[0] === '[') {
      let s = rest;
      while (flowDepth(s) > 0) {
        if (p >= lines.length) throw new YamlError('unterminated flow collection', line.no);
        s += ' ' + lines[p]!.text; p++;
      }
      const f = new Flow(s, line.no); const v = f.value(); f.done(); return v;
    }
    if (rest[0] === '"' || rest[0] === "'") { const f = new Flow(rest, line.no); const v = f.quoted(); f.done(); return v; }
    if (/^[&*!]/.test(rest)) throw new YamlError('anchors, aliases and tags are not supported', line.no);
    return resolvePlain(rest);
  }

  function blockScalar(header: string, parentIndent: number): string {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body: string[] = [];
    let ind = -1;
    while (p < lines.length) {
      const l = lines[p]!;
      if (l.raw.trim() === '') { body.push(''); p++; continue; }
      if (l.indent <= parentIndent) break;
      if (ind < 0) ind = l.indent;
      body.push(l.raw.slice(Math.min(ind, l.indent))); p++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    let text = folded ? body.join('\n').replace(/([^\n])\n(?=[^\n ])/g, '$1 ') : body.join('\n');
    if (chomp === 'clip' && body.length) text += '\n';
    if (chomp === 'keep') text += '\n'.repeat(trailing + 1);
    return text;
  }

  function node(minIndent: number): YamlValue {
    skipBlank();
    if (p >= lines.length || lines[p]!.indent < minIndent) return null;
    const l = lines[p]!;
    return l.text === '-' || l.text.startsWith('- ') ? seq(l.indent) : map(l.indent);
  }

  function valueAfterKey(rest: string, line: Line, indent: number): YamlValue {
    if (rest === '') {
      skipBlank();
      const n = lines[p];
      if (n && n.indent === indent && (n.text === '-' || n.text.startsWith('- '))) return seq(indent);
      return node(indent + 1);
    }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest, indent);
    return inline(rest, line);
  }

  function map(indent: number): { [k: string]: YamlValue } {
    const out: { [k: string]: YamlValue } = {};
    for (;;) {
      skipBlank();
      const l = lines[p];
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError(`unexpected indentation (${l.indent}, expected ${indent})`, l.no);
      if (l.text === '-' || l.text.startsWith('- ')) return out; // sequence at same indent belongs to the parent key
      const kv = splitKey(l.text, l.no);
      if (!kv) throw new YamlError(`expected "key: value", got "${l.text}"`, l.no);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, l.no);
      p++;
      out[kv.key] = valueAfterKey(kv.rest, l, indent);
    }
  }

  function seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      skipBlank();
      const l = lines[p];
      if (!l || l.indent < indent || !(l.text === '-' || l.text.startsWith('- '))) return out;
      if (l.indent > indent) throw new YamlError('unexpected indentation in sequence', l.no);
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      if (rest === '') { p++; out.push(node(indent + 1)); continue; }
      const kv = rest[0] === '{' || rest[0] === '[' ? undefined : splitKey(rest, l.no);
      if (kv) {
        // "- key: value" starts a block mapping indented at the item content column.
        const col = l.indent + (l.text.length - rest.length);
        lines[p] = { ...l, indent: col, text: rest };
        out.push(map(col));
        continue;
      }
      p++;
      out.push(inline(rest, l));
    }
  }

  const v = node(0);
  skipBlank();
  if (p < lines.length) throw new YamlError(`unexpected content "${lines[p]!.text}"`, lines[p]!.no);
  return v;
}
