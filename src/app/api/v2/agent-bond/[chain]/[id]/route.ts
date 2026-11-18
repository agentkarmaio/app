/**
 * GET /api/v2/agent-bond/[chain]/[id]
 *
 * Agent Bond (slashable self-stake) state for one stellar-8004 agentId:
 * bonded / unbonding amounts, unlock time, slash history with evidence
 * pointers, and how the bond currently feeds the Provider score.
 *
 * Agent Bond is a separate product operated by AgentKarma Labs on Stellar
 * TESTNET only (contracts/agent-bond, RFC v0.3.4-draft §12.1). Not to be
 * confused with the third-party surety bonds at /api/v2/bond.
 *
 * Amounts are human USDC as 7-decimal strings. Evidence is an audit pointer,
 * not verified on-chain.
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAgentBond, getAgentBondInput } from '@/db/client';
import { CHAINS, type Chain } from '@/db/schema';
import { STELLAR_TESTNET_AGENT_BOND } from '@/integrations/stellar-config';
import { networkTag } from '@/lib/api-only-chain';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';
import { applyAgentBond, AGENT_BOND_SCORING_CHAIN } from '@/scoring/agent-bond';

const MAX_INT32 = 2147483647;
const ZERO = '0.0000000';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chain: string; id: string }> },
) {
  const gate = await enforceRateLimit('agent-bond', request);
  if (!gate.ok) return gate.response;
  const headers = { ...gate.headers, ...corsHeaders() };
  const { chain: chainParam, id } = await params;

  if (!CHAINS.includes(chainParam as Chain)) {
    return NextResponse.json({ error: `unknown chain '${chainParam}'` }, { status: 400, headers });
  }
  const chain = chainParam as Chain;
  if (chain !== AGENT_BOND_SCORING_CHAIN) {
    return NextResponse.json({ error: `agent bond not available on chain '${chain}'` }, { status: 404, headers });
  }
  const agentId = Number(id);
  if (!/^\d+$/.test(id) || agentId > MAX_INT32) {
    return NextResponse.json({ error: 'agentId must be a nonnegative integer within int32 range' }, { status: 400, headers });
  }

  const contract = STELLAR_TESTNET_AGENT_BOND.contractId;
  const { bond, slashes } = await getAgentBond(contract, agentId);
  if (!bond) {
    return NextResponse.json({ error: `no agent bond for agent ${agentId} on ${chain}` }, { status: 404, headers });
  }

  const input = await getAgentBondInput(bond.owner_wallet, chain, contract);
  // Strength and penalty do not depend on the score; the lift does, and is
  // reported on the score response (`agentBond` on /api/v2/score/[wallet]).
  const effect = applyAgentBond(0, input).effect;
  const unlocked = bond.unlock_at !== null && Date.parse(bond.unlock_at) <= Date.now();

  return NextResponse.json(
    {
      chain,
      ...networkTag(chain),
      agentId,
      address: bond.owner_wallet,
      contract,
      operator: 'AgentKarma Labs',
      bonded: bond.bonded,
      unbonding: bond.unbonding,
      unlockAt: bond.unlock_at,
      withdrawableNow: unlocked ? bond.unbonding : ZERO,
      slashedTotal: bond.slashed_total,
      firstDepositAt: bond.first_deposit_at,
      slashes: slashes.map((s) => ({
        amount: s.amount,
        evidence: s.evidence ? { ...s.evidence, id: s.evidence_id } : null,
        slasher: s.slasher,
        txHash: s.tx_hash,
        at: s.ledger_closed_at,
      })),
      scoreEffect: {
        countedUsdc: input?.countedUsdc ?? 0,
        strength: effect?.strength ?? 0,
        slashPenalty: effect?.penalty ?? 0,
      },
    },
    { headers: { ...headers, 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  );
}
