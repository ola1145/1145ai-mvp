/**
 * A small YAML reader for the subset eval scenarios use: block maps and sequences, flow maps and sequences,
 * quoted and plain scalars, comments. It exists because dependencies are pre-declared and this lane may not add
 * any. Anything outside the subset (anchors, block scalars, tags, multi-document files) throws instead of guessing.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line { indent: number; text: string; no: number }

const fail = (msg: string, no?: number): never => {
  throw new Error(`yaml: ${msg}${no ? ` (line ${no})` : ''}`);
};

/** Remove a trailing `# comment` that is not inside quotes. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // a quote only opens a string at a token start
      if (i === 0 || /[\s:[{,-]/.test(raw[i - 1]!)) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]!))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    if (/^\t/.test(raw)) fail('tabs are not allowed for indentation', i + 1);
    const text = stripComment(raw).replace(/\s+$/, '');
    if (!text.trim()) return;
    if (/^(---|\.\.\.)$/.test(text.trim())) return;
    out.push({ indent: text.length - text.trimStart().length, text: text.trimStart(), no: i + 1 });
  });
  return out;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };

/** Reads a quoted string at s[i]; returns the value and the index after the closing quote. */
function readQuoted(s: string, i: number): [string, number] {
  const q = s[i]!;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (q === '"' && c === '\\') {
      const n = s[++j];
      if (n === undefined) break;
      out += ESCAPES[n] ?? n;
    } else if (q === "'" && c === "'" && s[j + 1] === "'") {
      out += "'";
      j++;
    } else if (c === q) {
      return [out, j + 1];
    } else {
      out += c;
    }
  }
  return fail(`unterminated string: ${s}`);
}

function plainScalar(raw: string): YamlValue {
  const t = raw.trim();
  if (t === '' || t === '~' || /^null$/i.test(t)) return null;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t) && !/^[-+]?0\d/.test(t)) return Number(t);
  if (/^[|>][+-]?\d*$/.test(t)) return fail('unsupported block scalar (| or >); use a quoted string');
  if (/^[&*!]/.test(t)) return fail(`unsupported anchor, alias or tag: ${t}`);
  return t;
}

// ---- flow collections: { a: 1, b: [x, "y"] } ----
function parseFlow(s: string, start = 0): [YamlValue, number] {
  let i = start;
  const ws = () => { while (i < s.length && /\s/.test(s[i]!)) i++; };
  const value = (stops: string): YamlValue => {
    ws();
    const c = s[i];
    if (c === '{') return map();
    if (c === '[') return seq();
    if (c === '"' || c === "'") { const [v, n] = readQuoted(s, i); i = n; return v; }
    let j = i;
    while (j < s.length && !stops.includes(s[j]!)) j++;
    const raw = s.slice(i, j);
    i = j;
    return plainScalar(raw);
  };
  const map = (): YamlValue => {
    i++; // {
    const obj: { [k: string]: YamlValue } = {};
    ws();
    if (s[i] === '}') { i++; return obj; }
    for (;;) {
      ws();
      let key: string;
      if (s[i] === '"' || s[i] === "'") { const [k, n] = readQuoted(s, i); key = k; i = n; }
      else { let j = i; while (j < s.length && s[j] !== ':' && s[j] !== ',' && s[j] !== '}') j++; key = s.slice(i, j).trim(); i = j; }
      ws();
      if (s[i] !== ':') return fail(`expected ":" after key "${key}" in ${s}`);
      i++;
      obj[key] = value(',}');
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return obj; }
      return fail(`unterminated flow map: ${s}`);
    }
  };
  const seq = (): YamlValue => {
    i++; // [
    const arr: YamlValue[] = [];
    ws();
    if (s[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(value(',]'));
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return arr; }
      return fail(`unterminated flow sequence: ${s}`);
    }
  };
  const v = value('');
  return [v, i];
}

function parseInline(text: string, no: number): YamlValue {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    const [v, end] = parseFlow(t);
    if (t.slice(end).trim()) fail(`unexpected text after flow value: ${t.slice(end)}`, no);
    return v;
  }
  if (t[0] === '"' || t[0] === "'") {
    const [v, end] = readQuoted(t, 0);
    if (t.slice(end).trim()) fail(`unexpected text after string: ${t.slice(end)}`, no);
    return v;
  }
  return plainScalar(t);
}

/** Finds the `key:` split of a block map line, or null if the line is not a map entry. */
function splitKey(text: string): { key: string; rest: string } | null {
  let i = 0;
  let key: string;
  if (text[0] === '"' || text[0] === "'") {
    const [k, n] = readQuoted(text, 0);
    key = k;
    i = n;
    if (text[i] !== ':' || (i + 1 < text.length && text[i + 1] !== ' ')) return null;
    return { key, rest: text.slice(i + 1) };
  }
  if (text[0] === '{' || text[0] === '[') return null;
  for (; i < text.length; i++) {
    if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return { key: text.slice(0, i).trim(), rest: text.slice(i + 1) };
  }
  return null;
}

class Parser {
  private pos = 0;
  constructor(private readonly lines: Line[]) {}

  parseDocument(): YamlValue {
    if (!this.lines.length) return null;
    const v = this.block(this.lines[0]!.indent);
    if (this.pos < this.lines.length) fail('unexpected indentation', this.lines[this.pos]!.no);
    return v;
  }

  private block(indent: number): YamlValue {
    const line = this.lines[this.pos]!;
    if (line.indent !== indent) fail('bad indentation', line.no);
    return line.text === '-' || line.text.startsWith('- ') ? this.sequence(indent) : this.mapping(indent);
  }

  private mapping(indent: number): YamlValue {
    const obj: { [k: string]: YamlValue } = {};
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) fail('bad indentation', line.no);
      if (line.text === '-' || line.text.startsWith('- ')) break;
      const kv = splitKey(line.text);
      if (!kv) fail(`expected "key: value", got: ${line.text}`, line.no);
      const { key, rest } = kv!;
      if (key in obj) fail(`duplicate key "${key}"`, line.no);
      this.pos++;
      if (rest.trim() === '') {
        const next = this.lines[this.pos];
        if (next && next.indent > indent) obj[key] = this.block(next.indent);
        else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) obj[key] = this.sequence(indent);
        else obj[key] = null;
      } else {
        obj[key] = parseInline(rest, line.no);
      }
    }
    return obj;
  }

  private sequence(indent: number): YamlValue {
    const arr: YamlValue[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) fail('bad indentation', line.no);
      if (!(line.text === '-' || line.text.startsWith('- '))) break;
      const content = line.text === '-' ? '' : line.text.slice(2);
      const offset = line.text.length - content.trimStart().length;
      if (content.trim() === '') {
        this.pos++;
        const next = this.lines[this.pos];
        arr.push(next && next.indent > indent ? this.block(next.indent) : null);
      } else if (splitKey(content.trimStart())) {
        // "- key: value" starts a mapping whose keys line up after the dash
        this.lines[this.pos] = { indent: indent + offset, text: content.trimStart(), no: line.no };
        arr.push(this.mapping(indent + offset));
      } else {
        this.pos++;
        arr.push(parseInline(content, line.no));
      }
    }
    return arr;
  }
}

export function parseYaml(src: string): YamlValue {
  return new Parser(toLines(src)).parseDocument();
}
