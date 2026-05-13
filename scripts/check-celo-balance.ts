/**
 * Check the AgentKarma Celo wallet balance.
 * Reads address from .keys/agentkarma-celo.json — never touches the private key.
 */

import { createPublicClient, http, formatEther } from 'viem';
import { celo } from 'viem/chains';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const keyfile = resolve('.keys/agentkarma-celo.json');
const { address } = JSON.parse(readFileSync(keyfile, 'utf-8')) as { address: `0x${string}` };

const client = createPublicClient({ chain: celo, transport: http() });

const balance = await client.getBalance({ address });
const nonce = await client.getTransactionCount({ address });

console.log('Address: ', address);
console.log('Balance: ', formatEther(balance), 'CELO');
console.log('Nonce:   ', nonce, '(tx count from this wallet)');
console.log('Explorer:', `https://celoscan.io/address/${address}`);
