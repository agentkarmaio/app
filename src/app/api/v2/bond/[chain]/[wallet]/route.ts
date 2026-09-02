/**
 * GET /api/v2/bond/{chain}/{wallet}
 *
 * The agent's bonding posture, two ways:
 *   1. `bonds` — surety bonds taken out ON this agent (third parties staked that
 *      this young agent will deliver). Split into open vs resolved.
 *   2. `surety` — this wallet's own underwriting activity (it backs OTHER
 *      agents' bonds), plus its orthogonal Surety Karma score.
 *
 * AK never holds the bond and is NEVER the resolution oracle (RFC §12 Non-
 * Custody). This is a read-only projection of the escrow's public lifecycle.
 * Demo/seeded bonds carry `isDemo: true` and are visibly flagged.
 *
 * CARDINAL RULE (enforced in scoring, surfaced here for context): a bond lifts
 * the bonded agent's confidence badge + Tier-1 presence ONLY — never the
 * evidence-gated trust ceiling. Surety Karma is ORTHOGONAL, never folded into
 * the wallet's Provider/Consumer score.
 *
 * Read-only, public, CORS-enabled.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getBondsForAgent, getUnderwriterPositions } from '@/db/client';
import { computeSurety } from '@/scoring/surety';
import { resolveChainParam, canonicalAddress } from '@/lib/chain-detect';
import { corsHeaders, corsPreflight } from '@/lib/rate-limit';
import {
  buildBondView, buildSuretyView, isBondSettled, toSuretyPosition,
  type BondView, type SuretyView,
} from '@/lib/succession-view';

export async function OPTIONS() {
  return corsPreflight();
}

export interface BondResponse {
  chain: string;
  address: string;
  /** Bonds taken out on this agent. */
  bonds: {
    open: BondView[];
    resolved: BondView[];
    totalBondedUsdc: number;
    hasDemo: boolean;
  };
  /** This wallet's underwriting activity + orthogonal Surety Karma (null if none). */
  surety: SuretyView | null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ chain: string; wallet: string }> },
) {
  const { chain: chainParam, wallet: rawWallet } = await params;
  const wallet = canonicalAddress(rawWallet);

  const chain = resolveChainParam(chainParam, wallet);
  if (!chain) {
    return NextResponse.json(
      { error: 'Invalid chain or wallet for chain' },
      { status: 400, headers: corsHeaders() },
    );
  }

  const [bonds, positions] = await Promise.all([
    getBondsForAgent(wallet, chain),
    getUnderwriterPositions(wallet, chain),
  ]);

  const views = bonds.map(buildBondView);
  const open = views.filter((b) => !isBondSettled(b.status) && b.status !== 'expired');
  const resolved = views.filter((b) => isBondSettled(b.status) || b.status === 'expired');
  const totalBondedUsdc = views.reduce((sum, b) => sum + (b.currency === 'USDC' ? b.amount : 0), 0);
  const hasDemo = views.some((b) => b.isDemo);

  const suretyResult = computeSurety(positions.map(toSuretyPosition));
  const surety = suretyResult ? buildSuretyView(suretyResult) : null;

  const body: BondResponse = {
    chain,
    address: wallet,
    bonds: {
      open,
      resolved,
      totalBondedUsdc: Math.round(totalBondedUsdc * 1e6) / 1e6,
      hasDemo,
    },
    surety,
  };

  return NextResponse.json(body, {
    headers: {
      ...corsHeaders(),
      'Cache-Control': 'public, max-age=60',
    },
  });
}
