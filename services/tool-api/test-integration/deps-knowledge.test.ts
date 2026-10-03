import { describe, expect, it } from 'vitest';
import { s3VectorsKnowledge } from '../src/deps.js';

const filter = { $and: [{ tenantId: { $eq: 't_a1' } }, { verified: { $eq: true } }] };

describe('s3VectorsKnowledge adapter', () => {
  it('embeds the text, queries with the caller-built filter untouched, and maps metadata to hits', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const index = s3VectorsKnowledge({
      vectorBucketName: 'vb', indexName: 'kb',
      embed: async (text) => (text === 'opening hours' ? [0.1, 0.2] : []),
      queryVectors: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { vectors: [
          { key: 'v1', distance: 0.12, metadata: { text: 'Open 9 to 5', source: 'owner', verified: true, tenantId: 't_a1' } },
          { key: 'v2', metadata: { text: 'no source', tenantId: 't_a1' } },
        ] };
      },
    });
    const hits = await index.query({ tenantId: 't_a1', verifiedOnly: true, text: 'opening hours', topK: 3, filter });
    expect(calls).toEqual([{ vectorBucketName: 'vb', indexName: 'kb', queryVector: { float32: [0.1, 0.2] }, topK: 3, filter, returnMetadata: true, returnDistance: true }]);
    expect(hits[0]).toMatchObject({ text: 'Open 9 to 5', source: 'owner', verified: true, tenantId: 't_a1' });
    // A hit with missing metadata is treated as unverified, never promoted.
    expect(hits[1]).toMatchObject({ verified: false });
  });
  it('drops hits that have no text or no tenant', async () => {
    const index = s3VectorsKnowledge({
      vectorBucketName: 'vb', indexName: 'kb', embed: async () => [1],
      queryVectors: async () => ({ vectors: [{ key: 'x', metadata: { source: 's', verified: true } }, { key: 'y', metadata: { text: 't', verified: true } }] }),
    });
    expect(await index.query({ tenantId: 't_a1', verifiedOnly: true, text: 'q', topK: 2, filter })).toEqual([]);
  });
  it('drops a hit that belongs to another tenant even if the index ignored the filter', async () => {
    const index = s3VectorsKnowledge({
      vectorBucketName: 'vb', indexName: 'kb', embed: async () => [1],
      queryVectors: async () => ({ vectors: [
        { key: 'o', metadata: { text: 'other tenant secret', source: 's', verified: true, tenantId: 't_b2' } },
        { key: 'm', metadata: { text: 'mine', source: 's', verified: true, tenantId: 't_a1' } },
      ] }),
    });
    const hits = await index.query({ tenantId: 't_a1', verifiedOnly: true, text: 'q', topK: 2, filter });
    expect(hits.map((h) => h.text)).toEqual(['mine']);
  });
});
