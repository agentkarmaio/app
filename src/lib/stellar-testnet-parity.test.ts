/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { compareLegs, parseCsv, partnerLeg, usdcToUnits, type ParityLeg } from './stellar-testnet-parity';

const leg = (id: string, over: Partial<ParityLeg> = {}): ParityLeg =>
  ({ id, agentId: 10, direction: 'received', units: 10_000_000n, counted: true, ...over });

describe('usdcToUnits', () => {
  test('is exact integer math', () => {
    expect(usdcToUnits('146.4418')).toBe(1_464_418_000n);
    expect(usdcToUnits('0.0000001')).toBe(1n);
    expect(() => usdcToUnits('0.00000001')).toThrow();
  });
});

describe('parseCsv + partnerLeg', () => {
  const csv = 'op_id,idx,tx_hash,agent_id,payer,amount_usdc,at,counted\r\n9,0,h,10,GCUST,1.5,2026-10-14,true\n9,1,h,10,GAGENT,0.25,2026-10-14,false\n';
  const addr = (id: number) => (id === 10 ? 'GAGENT' : undefined);
  test('derives direction from the payer when the export has no direction column', () => {
    const legs = parseCsv(csv).map((r) => partnerLeg(r, addr));
    expect(legs).toEqual([
      { id: '9:0', agentId: 10, direction: 'received', units: 15_000_000n, counted: true },
      { id: '9:1', agentId: 10, direction: 'sent', units: 2_500_000n, counted: false },
    ]);
  });
  test('an excluded_reason column enables reason comparison; empty means none', () => {
    const [r] = parseCsv('op_id,idx,agent_id,payer,amount_usdc,counted,excluded_reason\n1,0,10,GOP,5,false,operator\n');
    expect(partnerLeg(r, addr).reason).toBe('operator');
  });
});

describe('compareLegs', () => {
  test('identical sets of received, sent and excluded legs report zero mismatches', () => {
    const legs = [leg('a:0'), leg('b:0', { counted: false, reason: 'owner' }), leg('c:0', { direction: 'sent', units: 5_000_000n })];
    expect(compareLegs(legs, structuredClone(legs)).mismatches).toEqual([]);
  });
  test('flags a missing leg, a differing amount, direction, counted flag and reason', () => {
    const ak = [leg('a:0'), leg('b:0', { counted: false, reason: 'listed' }), leg('d:0')];
    const partner = [leg('a:0', { units: 11_000_000n }), leg('b:0', { counted: false, reason: 'operator' }), leg('c:0', { direction: 'sent' })];
    const { mismatches } = compareLegs(ak, partner);
    expect(mismatches).toContain('a:0: amount 10000000 vs 11000000 units');
    expect(mismatches).toContain('b:0: reason listed vs operator');
    expect(mismatches).toContain('c:0: missing in AgentKarma (agent 10)');
    expect(mismatches).toContain('d:0: missing in partner export (agent 10)');
    expect(mismatches.some((m) => m.startsWith('agent 10: received total'))).toBe(true);
  });
  test('a partner export without reasons does not fail on reasons', () => {
    expect(compareLegs([leg('a:0', { counted: false, reason: 'owner' })], [leg('a:0', { counted: false })]).mismatches).toEqual([]);
  });
});
