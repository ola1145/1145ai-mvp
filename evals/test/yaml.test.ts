import { describe, expect, it } from 'vitest';
import { parseYaml } from '../src/yaml.js';

describe('parseYaml (the subset eval scenarios use)', () => {
  it('parses block maps, scalars and trailing comments', () => {
    const doc = parseYaml('agent: customer\nchannel: voice   # spoken\ncaller_id: "+12145550123"\nrepeat: 3\nafter_hours: true\nnothing: null\n');
    expect(doc).toEqual({ agent: 'customer', channel: 'voice', caller_id: '+12145550123', repeat: 3, after_hours: true, nothing: null });
  });

  it('keeps # inside quotes', () => {
    expect(parseYaml('a: "room #5"\nb: \'x # y\'\n')).toEqual({ a: 'room #5', b: 'x # y' });
  });

  it('parses block sequences of mappings with flow values', () => {
    const doc = parseYaml(
      [
        'turns:',
        '  - caller: "Hi, can I get a haircut?"',
        '    expect: { tools_called: [check_availability], reply_max_chars: 220 }',
        '    fake: { reply: "Sure, when works for you?", tools: [check_availability] }',
        '  - owner: "Tue to Sat"',
        '    expect: { reply_contains_any: ["Tuesday", "Tue"] }',
      ].join('\n'),
    );
    expect(doc).toEqual({
      turns: [
        { caller: 'Hi, can I get a haircut?', expect: { tools_called: ['check_availability'], reply_max_chars: 220 }, fake: { reply: 'Sure, when works for you?', tools: ['check_availability'] } },
        { owner: 'Tue to Sat', expect: { reply_contains_any: ['Tuesday', 'Tue'] } },
      ],
    });
  });

  it('handles nested maps, scalar lists and quoted colons', () => {
    const doc = parseYaml('rules:\n  first_utterance_contains: ["AI", "recorded"]\ntags:\n  - skeptical\n  - "a: b"\n');
    expect(doc).toEqual({ rules: { first_utterance_contains: ['AI', 'recorded'] }, tags: ['skeptical', 'a: b'] });
  });

  it('handles flow strings that contain commas, brackets and dollar signs', () => {
    expect(parseYaml('x: { reply_not_contains: ["$", "a, b", "[x]"] }')).toEqual({ x: { reply_not_contains: ['$', 'a, b', '[x]'] } });
  });

  it('decodes common double-quote escapes', () => {
    expect(parseYaml('a: "say \\"hi\\"\\nthere"')).toEqual({ a: 'say "hi"\nthere' });
  });

  it('rejects syntax it does not support instead of guessing', () => {
    expect(() => parseYaml('a: |\n  block\n')).toThrow(/unsupported/i);
    expect(() => parseYaml('a: [1, 2')).toThrow();
  });
});
