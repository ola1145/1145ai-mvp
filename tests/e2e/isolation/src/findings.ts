export interface Finding { check: string; ok: boolean; detail: string }

export const pass = (check: string, detail = 'ok'): Finding => ({ check, ok: true, detail });
export const fail = (check: string, detail: string): Finding => ({ check, ok: false, detail });
export const failures = (f: Finding[]): Finding[] => f.filter((x) => !x.ok);

/** Vitest-friendly: empty string when everything held, otherwise one line per broken check. */
export function describeFailures(f: Finding[]): string {
  return failures(f).map((x) => `  FAIL ${x.check}: ${x.detail}`).join('\n');
}
