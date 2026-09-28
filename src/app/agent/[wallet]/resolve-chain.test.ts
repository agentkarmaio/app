import { describe, expect, test } from 'bun:test';
import { parseAgentIdHint } from './resolve-chain';

describe('parseAgentIdHint', () => {
  test('absent hint is neither an id nor malformed', () => {
    expect(parseAgentIdHint(undefined)).toEqual({ agentId: null, malformed: false });
  });
  test('a non-negative safe integer is an id (zero included)', () => {
    expect(parseAgentIdHint('186')).toEqual({ agentId: 186, malformed: false });
    expect(parseAgentIdHint('0')).toEqual({ agentId: 0, malformed: false });
  });
  test('anything else is malformed, never NaN (cache keys JSON-collapse NaN into null)', () => {
    for (const hint of ['abc', '', '-1', '1.5', ' 7', '99999999999999999999']) {
      expect(parseAgentIdHint(hint)).toEqual({ agentId: null, malformed: true });
    }
  });
});
