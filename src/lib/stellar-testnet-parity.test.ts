/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { compareLegs, parseCsv, partnerLegs, usdcToUnits, type ParityLeg } from './stellar-testnet-parity';

const leg = (id: string, over: Partial<ParityLeg> = {}): ParityLeg =>
  ({ id, agentId: 10, direction: 'received', units: 10_000_000n, counted: true, ...over });

describe('usdcToUnits', () => {
  test('is exact integer math', () => {
    expect(usdcToUnits('146.4418')).toBe(1_464_418_000n);
    expect(usdcToUnits('0.0000001')).toBe(1n);
    expect(() => usdcToUnits('0.00000001')).toThrow();
  });
});

describe('parseCsv + partnerLegs', () => {
  const csv = 'op_id,idx,tx_hash,agent_id,payer,payer_agent_id,amount_usdc,asset,at\r\n'
    + '9,0,h,10,GCUST,,1.5,USDC:ISS,2026-10-14\n9,1,h,10,GAGENT,12,0.25,USDC:ISS,2026-10-14\n9,2,h,10,GX,,3,EURC:ISS,2026-10-14\n';
  test('a payer_agent_id row is also that agent\'s sent leg; other assets are skipped', () => {
    const legs = parseCsv(csv).flatMap((r) => partnerLegs(r, 'USDC:ISS'));
    expect(legs).toEqual([
      { id: '9:0', agentId: 10, direction: 'received', units: 15_000_000n },
      { id: '9:1', agentId: 10, direction: 'received', units: 2_500_000n },
      { id: '9:1', agentId: 12, direction: 'sent', units: 2_500_000n },
    ]);
  });
  test('a self leg is received-only; counted / excluded_reason columns are honored when present', () => {
    const [r] = parseCsv('op_id,idx,agent_id,payer_agent_id,amount_usdc,counted,excluded_reason\n1,0,10,10,5,false,self\n');
    expect(partnerLegs(r)).toEqual([{ id: '1:0', agentId: 10, direction: 'received', units: 50_000_000n, counted: false, reason: 'self' }]);
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
    expect(mismatches).toContain('c:0: missing in AgentKarma (sent, agent 10)');
    expect(mismatches).toContain('d:0: missing in partner export (received, agent 10)');
    expect(mismatches.some((m) => m.startsWith('agent 10: received total'))).toBe(true);
  });
  test('a partner export without reasons does not fail on reasons; without counted it skips counted too', () => {
    expect(compareLegs([leg('a:0', { counted: false, reason: 'owner' })], [leg('a:0', { counted: false })]).mismatches).toEqual([]);
    const { counted: _c, ...bare } = leg('a:0');
    expect(compareLegs([leg('a:0', { counted: false })], [bare]).mismatches).toEqual([]);
  });
  test('the same leg as received by one agent and sent by another is two legs', () => {
    const ak = [leg('a:0'), leg('a:0', { agentId: 12, direction: 'sent' })];
    expect(compareLegs(ak, structuredClone(ak)).mismatches).toEqual([]);
    expect(compareLegs(ak, [ak[0]]).mismatches).toContain('a:0: missing in partner export (sent, agent 12)');
  });
});
