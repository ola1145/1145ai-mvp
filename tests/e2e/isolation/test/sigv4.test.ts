import { describe, expect, it } from 'vitest';
import { signV4 } from '../src/sigv4.js';

describe('signV4', () => {
  // The "get-vanilla" vector from the AWS Signature Version 4 test suite.
  it('matches the published AWS get-vanilla test vector', () => {
    const h = signV4({
      method: 'GET', url: 'https://example.amazonaws.com/', service: 'service', region: 'us-east-1',
      headers: {}, body: '', now: new Date('2015-08-30T12:36:00Z'),
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });

  it('signs the session token header when present', () => {
    const h = signV4({
      method: 'POST', url: 'https://dynamodb.us-east-1.amazonaws.com/', service: 'dynamodb', region: 'us-east-1',
      headers: { 'content-type': 'application/x-amz-json-1.0' }, body: '{}', now: new Date('2026-01-01T00:00:00Z'),
      creds: { accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 'tok' },
    });
    expect(h['x-amz-security-token']).toBe('tok');
    expect(h.authorization).toContain('x-amz-security-token');
  });
});
