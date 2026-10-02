/** Path specs are exact files ("a/b.ts") or directory prefixes ("a/**"). Kept simple on purpose so overlap is decidable. */
export function normalize(spec: string): { kind: 'file' | 'dir'; path: string } {
  if (spec.includes('*') && !spec.endsWith('/**')) throw new Error(`unsupported pattern: ${spec} (use exact paths or dir/**)`);
  return spec.endsWith('/**') ? { kind: 'dir', path: spec.slice(0, -3) + '/' } : { kind: 'file', path: spec };
}

export function specsOverlap(a: string, b: string): boolean {
  const x = normalize(a); const y = normalize(b);
  if (x.kind === 'file' && y.kind === 'file') return x.path === y.path;
  if (x.kind === 'dir' && y.kind === 'dir') return x.path.startsWith(y.path) || y.path.startsWith(x.path);
  const [dir, file] = x.kind === 'dir' ? [x.path, y.path] : [y.path, x.path];
  return file.startsWith(dir);
}

export function matches(spec: string, file: string): boolean {
  const s = normalize(spec);
  return s.kind === 'file' ? s.path === file : file.startsWith(s.path);
}

export function findOverlaps(issues: ReadonlyArray<{ id: string; owns: string[] }>): string[] {
  const out: string[] = [];
  for (let i = 0; i < issues.length; i++) for (let j = i + 1; j < issues.length; j++) {
    for (const a of issues[i]!.owns) for (const b of issues[j]!.owns) {
      if (specsOverlap(a, b)) out.push(`${issues[i]!.id} (${a}) overlaps ${issues[j]!.id} (${b})`);
    }
  }
  return out;
}

/** Files in a PR that the issue does not own. */
export function outsideOwnership(owns: string[], changed: string[], alwaysAllowed: (f: string) => boolean): string[] {
  return changed.filter((f) => !alwaysAllowed(f) && !owns.some((s) => matches(s, f)));
}
