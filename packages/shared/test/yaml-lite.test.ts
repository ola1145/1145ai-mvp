import { describe, expect, it } from 'vitest';
import { parseYaml, YamlError } from './support/yaml-lite.js';

describe('yaml-lite (contract test helper)', () => {
  it('parses block and flow styles the way the contracts use them', () => {
    const doc = parseYaml([
      'openapi: 3.1.0  # comment',
      'info:',
      '  title: A title, with commas',
      '  description: |',
      '    line one',
      '    line two',
      'servers:',
      '  - url: https://api.1145.ai',
      '    note: second key',
      'security:',
      '  - tenantToken: []',
      'paths:',
      "  /v1/x/{id}:      { post: { operationId: doX, x-principals: [owner, admin-agent], summary: 'a, b # not a comment' } }",
      '  /v1/y:',
      '    get:',
      "      parameters: [ { name: from, in: query, required: true, schema: { type: string, pattern: '^\\d{2}$' } } ]",
      "      responses: { '200': { description: Calls, bookings }, '404': { description: \"it's \\\"quoted\\\"\" } }",
      '      x-multi: {',
      '        a: 1, b: [true, null, 2.5],',
      "        c: 'it''s'",
      '      }',
    ].join('\n'));
    expect(doc).toEqual({
      openapi: '3.1.0',
      info: { title: 'A title, with commas', description: 'line one\nline two\n' },
      servers: [{ url: 'https://api.1145.ai', note: 'second key' }],
      security: [{ tenantToken: [] }],
      paths: {
        '/v1/x/{id}': { post: { operationId: 'doX', 'x-principals': ['owner', 'admin-agent'], summary: 'a, b # not a comment' } },
        '/v1/y': {
          get: {
            parameters: [{ name: 'from', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{2}$' } }],
            // Unquoted commas inside a flow mapping split keys, exactly like a real YAML parser would.
            responses: { '200': { description: 'Calls', bookings: null }, '404': { description: 'it\'s "quoted"' } },
            'x-multi': { a: 1, b: [true, null, 2.5], c: "it's" },
          },
        },
      },
    });
  });

  it('rejects malformed documents', () => {
    expect(() => parseYaml('a: { b: 1')).toThrow(YamlError);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/duplicate key/);
    expect(() => parseYaml('a:\n    b: 1\n  c: 2')).toThrow(YamlError);
    expect(() => parseYaml('a: [1, 2')).toThrow(/unterminated/);
  });
});
