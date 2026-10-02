import { HttpError } from './http.js';

export function str(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new HttpError(400, 'invalid', `${name} is required (max ${max} chars)`);
  return v.trim();
}
export function optStr(v: unknown, name: string, max = 500): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : str(v, name, max);
}
export function isoDate(v: unknown, name: string): Date {
  const d = new Date(str(v, name, 40));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid', `${name} must be an ISO date-time`);
  return d;
}
