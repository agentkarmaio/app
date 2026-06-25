/**
 * Generate an AgentKarma Celo keypair.
 *
 * Writes a fresh secp256k1 keypair to .keys/<name>.json with 0600 permissions.
 * Refuses to overwrite an existing keyfile. Prints ONLY the public address —
 * the private key never touches stdout or any log.
 *
 * Run:
 *   bun run scripts/generate-celo-keypair.ts                 # treasury/controller key
 *   bun run scripts/generate-celo-keypair.ts --validator     # dedicated validator key
 *   bun run scripts/generate-celo-keypair.ts --name foo      # arbitrary basename
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const isValidator = process.argv.includes('--validator');
const nameIdx = process.argv.indexOf('--name');
const name =
  nameIdx >= 0 && process.argv[nameIdx + 1]
    ? process.argv[nameIdx + 1]
    : isValidator
      ? 'agentkarma-celo-validator'
      : 'agentkarma-celo';
const purpose = isValidator
  ? 'AgentKarma dedicated Celo reputation-validator key (ReputationRegistry giveFeedback only; disclosed at /validator). Kept separate from the treasury/controller key.'
  : 'AgentKarma protocol identity on Celo (IdentityRegistry + ReputationRegistry writes, Self Agent ID)';

const keyDir = resolve('.keys');
const keyfile = resolve(keyDir, `${name}.json`);

if (existsSync(keyfile)) {
  console.error(`✖ refuse to overwrite existing keyfile: ${keyfile}`);
  console.error('  delete it manually if you really want to regenerate.');
  process.exit(1);
}

if (!existsSync(keyDir)) {
  mkdirSync(keyDir, { recursive: true });
  chmodSync(keyDir, 0o700);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

writeFileSync(
  keyfile,
  JSON.stringify(
    {
      address: account.address,
      privateKey,
      createdAt: new Date().toISOString(),
      purpose,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
chmodSync(keyfile, 0o600);

console.log(`AgentKarma Celo ${isValidator ? 'validator' : 'controller'} address:`, account.address);
console.log('Keyfile:', keyfile, '(0600)');
console.log('');
console.log('Next: fund this address with ~$2-5 worth of CELO for gas.');
console.log('Bridges: portalbridge.com, squid.li, or buy on a CEX and withdraw to Celo.');
