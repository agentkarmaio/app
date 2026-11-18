import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { STELLAR_TESTNET_AGENT_BOND } from '@/integrations/stellar-config';
import { GET } from './route';

const OWNER = 'GBTUWKBH5O7P4BHO772WF6HIYGQJBJQOGKRQMYTDP67FQKVG4IWMVUNH';
const DAY = 86_400_000;

let bond: ReturnType<typeof spyOn<typeof db, 'getAgentBond'>>;
let input: ReturnType<typeof spyOn<typeof db, 'getAgentBondInput'>>;
beforeEach(() => {
  bond = spyOn(db, 'getAgentBond').mockResolvedValue({
    bond: {
      chain: 'stellar-testnet', contract_id: STELLAR_TESTNET_AGENT_BOND.contractId, agent_id: 66, owner_wallet: OWNER,
      bonded: '450.0000000', unbonding: '50.0000000', unlock_at: new Date(Date.now() - DAY).toISOString(),
      slashed_total: '25.0000000', first_deposit_at: '2026-11-01T00:00:00.000Z', last_ledger: 5801300,
    },
    slashes: [{ amount: '25.0000000', evidence: { kind: 'assay', codeHash: 'aa'.repeat(32), recordDigest: 'bb'.repeat(32) },
      evidence_id: 'cc'.repeat(32), slasher: 'GSLASHER', tx_hash: 'dd'.repeat(32), ledger_closed_at: '2026-11-10T00:00:00.000Z' }],
  });
  input = spyOn(db, 'getAgentBondInput').mockResolvedValue({
    chain: 'stellar-testnet', countedStroops: 4_500_000_000n, slashedEver: true,
    lastSlashStroops: 250_000_000n, stakeBeforeLastSlashStroops: 5_250_000_000n,
  });
});
afterEach(() => { bond.mockRestore(); input.mockRestore(); });

const get = (id: string, chain = 'stellar-testnet') =>
  GET(new Request(`http://x/api/v2/agent-bond/${chain}/${id}`) as never, { params: Promise.resolve({ chain, id }) });

describe('GET /api/v2/agent-bond/[chain]/[id]', () => {
  test('returns bond state, slash history and the score effect, labelled testnet', async () => {
    const res = await get('66');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      chain: 'stellar-testnet', network: 'testnet', agentId: 66, address: OWNER,
      contract: STELLAR_TESTNET_AGENT_BOND.contractId,
      operator: 'AgentKarma Labs',
      bonded: '450.0000000', unbonding: '50.0000000', withdrawableNow: '50.0000000', slashedTotal: '25.0000000',
      slashes: [{ amount: '25.0000000', slasher: 'GSLASHER', evidence: { kind: 'assay', codeHash: 'aa'.repeat(32), recordDigest: 'bb'.repeat(32), id: 'cc'.repeat(32) } }],
      scoreEffect: { countedUsdc: '450.0000000', strength: 0, slashPenalty: 12.5 },
    });
    expect(bond).toHaveBeenCalledWith(STELLAR_TESTNET_AGENT_BOND.contractId, 66);
    expect(input).toHaveBeenCalledWith(OWNER, 'stellar-testnet', STELLAR_TESTNET_AGENT_BOND.contractId);
  });

  test('withdrawable is zero before unlock', async () => {
    bond.mockResolvedValue({ bond: { ...(await db.getAgentBond('', 0)).bond!, unlock_at: new Date(Date.now() + DAY).toISOString() }, slashes: [] });
    expect((await (await get('66')).json()).withdrawableNow).toBe('0.0000000');
  });

  test('404 for an agent with no bond', async () => {
    bond.mockResolvedValue({ bond: null, slashes: [] });
    expect((await get('5')).status).toBe(404);
  });

  test('only stellar-testnet has agent bonds', async () => {
    for (const chain of ['stellar', 'celo', 'solana']) expect((await get('1', chain)).status).toBe(404);
    expect((await get('1', 'nope')).status).toBe(400);
    expect(bond).not.toHaveBeenCalled();
  });

  test('malformed ids are rejected before lookup', async () => {
    for (const id of ['-1', '1.5', '1e2', '0x1', '2147483648']) expect((await get(id)).status).toBe(400);
    expect(bond).not.toHaveBeenCalled();
  });
});
