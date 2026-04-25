import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { claimWallet } from '@/db/client';
import { TEMPO_ADDRESS_REGEX } from '@/db/schema';

const VALID_CATEGORIES = ['ai', 'data', 'defi', 'infra', 'social', 'utility', 'other'];

/**
 * POST /api/agent/claim
 *
 * Claim a wallet to enrich its agent profile with identity metadata.
 * Requires a Solana wallet signature to prove ownership.
 *
 * Body:
 *   address:      string — wallet address
 *   displayName:  string — agent display name (required, 1-50 chars)
 *   description:  string — short description (optional, max 280 chars)
 *   website:      string — URL (optional)
 *   category:     string — one of VALID_CATEGORIES (optional)
 *   tempoAddress: string — Tempo (MPP) EVM 0x… 42-char address (optional, Tier 3 declared-only)
 *   signature:    string — base58-encoded Ed25519 signature
 *   message:      string — the signed message (must match expected format)
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { address, displayName, description, website, category, tempoAddress, signature, message } = body as {
    address?: string;
    displayName?: string;
    description?: string;
    website?: string;
    category?: string;
    tempoAddress?: string | null;
    signature?: string;
    message?: string;
  };

  // Validate required fields
  if (!address || !displayName || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: address, displayName, signature, message' },
      { status: 400 },
    );
  }

  // Validate address format
  try {
    new PublicKey(address);
  } catch {
    return NextResponse.json({ error: 'Invalid Solana wallet address' }, { status: 400 });
  }

  // Validate displayName length
  if (displayName.length < 1 || displayName.length > 50) {
    return NextResponse.json({ error: 'displayName must be 1-50 characters' }, { status: 400 });
  }

  // Validate description length
  if (description && description.length > 280) {
    return NextResponse.json({ error: 'description must be 280 characters or less' }, { status: 400 });
  }

  // Validate category
  if (category && !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }

  // Validate website URL format
  if (website) {
    try {
      new URL(website);
    } catch {
      return NextResponse.json({ error: 'website must be a valid URL' }, { status: 400 });
    }
  }

  // Validate Tempo address (EVM 0x… 42-char). Declared-only Tier 3 signal —
  // we do NOT verify ownership here; cross-chain wallet linkage is future work.
  if (tempoAddress && !TEMPO_ADDRESS_REGEX.test(tempoAddress)) {
    return NextResponse.json(
      { error: 'tempoAddress must be a valid EVM-style 0x… 42-character address' },
      { status: 400 },
    );
  }

  // Validate message format: "AgentKarma: Claim wallet {address} at {timestamp}"
  const messagePrefix = `AgentKarma: Claim wallet ${address} at `;
  if (!message.startsWith(messagePrefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }

  // Check timestamp is recent (within 5 minutes)
  const timestampStr = message.slice(messagePrefix.length);
  const messageTs = Number(timestampStr);
  if (isNaN(messageTs) || Math.abs(Date.now() - messageTs) > 5 * 60 * 1000) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // Verify Ed25519 signature
  try {
    const publicKey = new PublicKey(address);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58Decode(signature);

    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
    if (!valid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 });
  }

  // Write to DB
  try {
    await claimWallet(
      address,
      displayName,
      description ?? null,
      website ?? null,
      category ?? null,
      tempoAddress ?? null,
    );
  } catch (err) {
    console.error('[claim] DB error:', err);
    return NextResponse.json({ error: 'Failed to save claim' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    address,
    displayName,
    claimed: true,
  });
}

// Minimal base58 decode (Solana signature is base58-encoded)
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = BigInt(58);
  let num = BigInt(0);
  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * BASE + BigInt(index);
  }
  const hex = num.toString(16).padStart(2, '0');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // Handle leading zeros
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') leadingZeros++;
    else break;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}
