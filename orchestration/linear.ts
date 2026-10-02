/** Minimal Linear GraphQL client (personal API keys go in Authorization without "Bearer"). */
export async function linear<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY is not set');
  const r = await fetch('https://api.linear.app/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ query, variables }),
  });
  const body = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!r.ok || body.errors?.length) throw new Error(`Linear: ${r.status} ${body.errors?.map((e) => e.message).join('; ')}`);
  return body.data as T;
}

export const tag = (id: string) => `[1145:${id}]`;
