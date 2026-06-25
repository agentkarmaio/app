/**
 * Fund the dedicated AgentKarma Celo validator wallet for gas, from the
 * treasury/controller wallet. Keeps operational attestation writes off the
 * high-value treasury key (see /validator disclosure).
 *
 * Usage:
 *   bun run scripts/fund-celo-validator.ts [--amount 2] [--execute]
 *
 * Defaults to --simulate (prints the plan, sends nothing). ~0.04 CELO/attest,
 * so 2 CELO ≈ 50 records.
 */
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function argVal(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const execute = process.argv.includes('--execute');
const amount = argVal('amount', '2');

const { privateKey: treasuryPk } = JSON.parse(
  readFileSync(resolve('.keys/agentkarma-celo.json'), 'utf-8'),
) as { privateKey: `0x${string}` };
const { address: validator } = JSON.parse(
  readFileSync(resolve('.keys/agentkarma-celo-validator.json'), 'utf-8'),
) as { address: `0x${string}` };

const treasury = privateKeyToAccount(treasuryPk);
const publicClient = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC_URL) });

const [treasuryBal, validatorBal] = await Promise.all([
  publicClient.getBalance({ address: treasury.address }),
  publicClient.getBalance({ address: validator }),
]);

console.log('treasury :', treasury.address, formatEther(treasuryBal), 'CELO');
console.log('validator:', validator, formatEther(validatorBal), 'CELO');
console.log('transfer :', amount, 'CELO →', validator);
console.log('mode     :', execute ? 'EXECUTE' : 'simulate');

if (!execute) {
  console.log('\n--simulate: nothing sent. Re-run with --execute to fund.');
  process.exit(0);
}

const wallet = createWalletClient({ account: treasury, chain: celo, transport: http(process.env.CELO_RPC_URL) });
const hash = await wallet.sendTransaction({ to: validator, value: parseEther(amount) });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`funding tx reverted: ${hash}`);
console.log('\nfunded. tx:', `https://celoscan.io/tx/${hash}`);
console.log('validator balance now:', formatEther(await publicClient.getBalance({ address: validator })), 'CELO');
