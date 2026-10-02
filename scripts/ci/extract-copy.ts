/** Collect the lines customers and owners will actually hear or read, so CI can check them for robotic phrasing. */
export interface CopyLine { file: string; channel: 'voice' | 'chat'; text: string }

const unq = (s: string) => s.replace(/\$\{[^}]*\}/g, 'X').replace(/\\'/g, "'").replace(/\\"/g, '"');

export function fromTypeScript(file: string, src: string): CopyLine[] {
  const out: CopyLine[] = [];
  const re = /\b(sayToCaller|messageForOwner|ownerMessage)\s*:\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of src.matchAll(re)) out.push({ file, channel: m[1] === 'sayToCaller' ? 'voice' : 'chat', text: unq(m[3]!) });
  return out;
}

export function fromPython(file: string, src: string): CopyLine[] {
  const out: CopyLine[] = [];
  for (const m of src.matchAll(/^([A-Z][A-Z_]+)\s*=\s*"([^"\n]+)"\s*$/gm)) {
    if (/URL|MODEL|PREFIX|ID|KEY|PATH/.test(m[1]!)) continue;
    out.push({ file, channel: 'voice', text: m[2]! });
  }
  for (const m of src.matchAll(/^(FILLERS|ACKS)\s*=\s*\(([\s\S]*?)\)/gm)) {
    for (const s of m[2]!.matchAll(/"([^"]+)"/g)) out.push({ file, channel: 'voice', text: s[1]! });
  }
  return out;
}
