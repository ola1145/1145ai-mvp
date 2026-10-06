import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AuditEntry } from './types.js';

/**
 * Writes one JSON object per audit entry to the Object Lock bucket. Object Lock buckets reject puts without an
 * integrity header, so every put carries Content-MD5. A failed put throws: the console never changes anything it
 * could not record.
 *
 * TODO(H1): the shared writer (services/control-plane/src/audit.ts) is still a stub. Once it exports a function
 * with this shape, delete this file and call that one (contracts/CHANGE_REQUESTS/H2-1.md).
 */
export function auditKey(e: AuditEntry, id: string = randomUUID()): string {
  const d = e.at.slice(0, 10).split('-');
  return `audit/${d[0]}/${d[1]}/${d[2]}/${e.tenantId}/${e.at.replace(/[:.]/g, '-')}-${id}.json`;
}

export function auditWriter(s3: Pick<S3Client, 'send'>, bucket: string) {
  return async (entry: AuditEntry): Promise<void> => {
    const body = JSON.stringify({ ...entry, source: 'console' });
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: auditKey(entry),
      Body: body,
      ContentType: 'application/json',
      ContentMD5: createHash('md5').update(body).digest('base64'),
    }));
  };
}
