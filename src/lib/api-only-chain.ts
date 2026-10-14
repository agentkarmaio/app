/**
 * Write/ops rejection for API-only chains (stellar-testnet). Their data is
 * indexer-owned and served read-only through the API; profiles can't be
 * claimed, edited, published or drained from agentkarma.io.
 */
import { NextResponse } from 'next/server';
import { isApiOnlyChain } from '@/db/schema';

export const API_ONLY_CHAIN_ERROR = 'This network is API-only on AgentKarma and is read-only.';

/** A 403 for an API-only chain, else null. Call before any DB or network access. */
export function rejectApiOnlyChain(chain: unknown, headers?: HeadersInit): NextResponse | null {
  return isApiOnlyChain(chain)
    ? NextResponse.json({ error: API_ONLY_CHAIN_ERROR }, { status: 403, headers })
    : null;
}

/**
 * `{ network: 'testnet' }` for API-only chains, else nothing — spread into a
 * response so testnet payloads are self-describing while mainnet response
 * shapes stay byte-identical.
 */
export function networkTag(chain: unknown): { network: 'testnet' } | Record<string, never> {
  return isApiOnlyChain(chain) ? { network: 'testnet' } : {};
}
