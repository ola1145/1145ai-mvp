import type { HttpPort } from '../types.js';

/** fetch-based tool API client. Sends exactly what the probe built; never adds a tenant id of its own. */
export function fetchHttpPort(baseUrl: string, timeoutMs = 20_000): HttpPort {
  return async (req) => {
    const url = new URL(baseUrl.replace(/\/$/, '') + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
    if (req.token !== null) headers.authorization = `Bearer ${req.token}`;
    let body: string | undefined;
    if (req.body !== undefined && req.method !== 'GET') { body = JSON.stringify(req.body); headers['content-type'] = 'application/json'; }
    const res = await fetch(url, { method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  };
}
