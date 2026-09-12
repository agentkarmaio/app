import { describe, expect, test } from 'bun:test';
import { buildAgentMessage, parseAgentReply } from './agent-query';

const address = '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96';

describe('agent query input', () => {
  test('preserves the chain and registry ID from an AgentKarma profile', () => {
    const message = buildAgentMessage(`https://agentkarma.io/agent/${address}?chain=arc&agentId=72077`, 'q');
    expect(message.parts).toEqual([{ kind: 'data', data: { agentId: 72077, chain: 'arc' } }]);
  });
  test('requires an explicit EVM chain for ambiguous addresses and IDs', () => {
    expect(() => buildAgentMessage(address, 'q')).toThrow('celo or arc');
    expect(() => buildAgentMessage('agentId 9058', 'q')).toThrow('celo or arc');
  });
  test('does not route a Stellar numeric ID to an EVM registry', () => {
    expect(() => buildAgentMessage('agentId 66 on stellar', 'q')).toThrow('wallet address');
  });
  test('never fetches or accepts another host as an AgentKarma profile', () => {
    for (const url of [`https://agentkarma.io.evil.test/agent/${address}`, `https://evil.test/agent/${address}`, `https://user:pass@agentkarma.io/agent/${address}`, `http://agentkarma.io/agent/${address}`]) {
      expect(() => buildAgentMessage(url, 'q')).toThrow();
    }
  });
  test('rejects unknown chains, invalid IDs and oversized inputs', () => {
    expect(() => buildAgentMessage(`https://agentkarma.io/agent/${address}?chain=base`, 'q')).toThrow();
    expect(() => buildAgentMessage(`https://agentkarma.io/agent/${address}?chain=celo&agentId=0`, 'q')).toThrow();
    expect(() => buildAgentMessage('x'.repeat(4097), 'q')).toThrow();
    expect(() => buildAgentMessage(' ', 'q')).toThrow();
  });
  test('retains ordinary query text for the real A2A parser', () => {
    expect(buildAgentMessage('agentId 9058 on celo', 'q').parts).toEqual([{ kind: 'text', text: 'agentId 9058 on celo' }]);
  });
});

describe('agent response decoding', () => {
  const reply = (data: Record<string, unknown>, text = 'Agent reply') => ({
    jsonrpc: '2.0', id: 'q', result: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text }, { kind: 'data', data }] },
  });
  test('distinguishes no indexed data from a scored result', () => {
    expect(parseAgentReply(reply({ found: false, reason: 'no_target' }), 'q').found).toBe(false);
    expect(parseAgentReply(reply({ provider: { score: 0 }, consumer: { score: null } }), 'q').found).toBe(true);
  });
  test('HTTP 200 JSON-RPC errors cannot become success or leak upstream text', () => {
    expect(() => parseAgentReply({ jsonrpc: '2.0', id: 'q', error: { code: -32603, message: 'private connection details' } }, 'q')).toThrow('could not complete');
    expect(() => parseAgentReply({ jsonrpc: '2.0', id: 'q', error: { code: -32000 } }, 'q')).toThrow('Too many');
  });
  test('rejects mismatched, empty and malformed responses', () => {
    expect(() => parseAgentReply(reply({}), 'different')).toThrow();
    expect(() => parseAgentReply(reply({}, ''), 'q')).toThrow();
    expect(() => parseAgentReply({ jsonrpc: '2.0', id: 'q', result: {} }, 'q')).toThrow();
    expect(() => parseAgentReply(reply({}), 'q')).toThrow();
  });
  test('only exposes a local AgentKarma profile link', () => {
    const data = { provider: {}, consumer: {}, profileUrl: `https://agentkarma.io/agent/${address}?chain=celo&agentId=9058` };
    expect(parseAgentReply(reply(data), 'q').profilePath).toBe(`/agent/${address}?chain=celo&agentId=9058`);
    expect(parseAgentReply(reply({ ...data, profileUrl: 'javascript:alert(1)' }), 'q').profilePath).toBeNull();
    expect(parseAgentReply(reply({ ...data, profileUrl: 'https://evil.test/agent/x' }), 'q').profilePath).toBeNull();
  });
  test('Arc wallet evidence links stay on Arc even when the resolver URL has no chain', () => {
    const data = { chain: 'arc', agentId: 72077, provider: {}, consumer: {}, profileUrl: `https://agentkarma.io/agent/${address}` };
    expect(parseAgentReply(reply(data), 'q').profilePath).toBe(`/agent/${address}?chain=arc&agentId=72077`);
  });
});
