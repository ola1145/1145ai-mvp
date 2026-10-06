/** Pure helpers: what counts as tenant B data showing up where it must not. */

/** Markers (strings seeded only into tenant B's data) that appear in `text`. Case-sensitive on purpose. */
export function leaks(text: string, markers: readonly string[]): string[] {
  return markers.filter((m) => m.length > 0 && text.includes(m));
}

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Keep the header and signature, rewrite the tid claim. A verifying API must reject this. */
export function tamperTokenTid(token: string, tid: string): string {
  const [h, p, s] = token.split('.');
  if (!h || !p || s === undefined) throw new Error('not a three-part token');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  return `${h}.${b64u({ ...claims, tid })}.${s}`;
}

/** Unsigned token claiming tenant `tid`. A verifying API must reject it. */
export function algNoneToken(tid: string, prn: string): string {
  return `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ tid, prn, cid: 'isolation-probe', aud: 'tool-api' })}.`;
}
