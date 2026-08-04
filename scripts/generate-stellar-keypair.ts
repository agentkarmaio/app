/**
 * Generate the AgentKarma Stellar keypair.
 *
 * Writes a fresh Ed25519 keypair to .keys/agentkarma-stellar.json with 0600
 * permissions. Refuses to overwrite an existing keyfile. Prints ONLY the
 * public G-address — the secret key never touches stdout or any log.
 *
 * Run:
 *   bun run scripts/generate-stellar-keypair.ts
 */

import { Keypair } from '@stellar/stellar-sdk';
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const keyDir = resolve('.keys');
const keyfile = resolve(keyDir, 'agentkarma-stellar.json');

if (existsSync(keyfile)) {
  console.error(`✖ refuse to overwrite existing keyfile: ${keyfile}`);
  console.error('  delete it manually if you really want to regenerate.');
  process.exit(1);
}

if (!existsSync(keyDir)) {
  mkdirSync(keyDir, { recursive: true });
  chmodSync(keyDir, 0o700);
}

const keypair = Keypair.random();

writeFileSync(
  keyfile,
  JSON.stringify(
    {
      publicKey: keypair.publicKey(),
      secret: keypair.secret(),
      createdAt: new Date().toISOString(),
      purpose:
        'AgentKarma protocol identity on Stellar (stellar-8004 IdentityRegistry ' +
        'register + ReputationRegistry give_feedback as disclosed agentkarma_metadata validator)',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
chmodSync(keyfile, 0o600);

console.log('AgentKarma Stellar account:', keypair.publicKey());
console.log('Keyfile:', keyfile, '(0600)');
console.log('');
console.log('Next: fund this G-address with ~5 XLM (account creation min 1 XLM');
console.log('+ Soroban resource fees). Send native XLM from any wallet/CEX —');
console.log('the deposit itself creates the account.');
