/**
 * Inspect raw transaction structure from facilitator addresses
 * to understand how x402 USDC payments actually look on-chain.
 *
 * Usage: bun run src/scripts/inspect-tx.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ALL_FACILITATOR_ADDRESSES, getFacilitatorName, USDC_MINT } from '../config/facilitators';

const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
if (!rpcUrl) { console.error('HELIUS_RPC_URL required'); process.exit(1); }

const connection = new Connection(rpcUrl, 'confirmed');

async function inspect() {
  console.log('Inspecting transactions from facilitator addresses...\n');

  for (const addr of ALL_FACILITATOR_ADDRESSES) {
    const name = getFacilitatorName(addr) ?? addr.slice(0, 8);

    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(new PublicKey(addr), { limit: 5 });
    } catch (e) {
      console.log(`[${name}] Failed to get signatures: ${e}`);
      continue;
    }

    if (sigs.length === 0) {
      console.log(`[${name}] No signatures found\n`);
      continue;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`[${name}] ${addr}`);
    console.log(`  ${sigs.length} recent signatures`);

    // Inspect first 2 transactions in detail
    for (let i = 0; i < Math.min(2, sigs.length); i++) {
      const sig = sigs[i];
      console.log(`\n  --- TX ${i + 1}: ${sig.signature.slice(0, 20)}... ---`);
      console.log(`  Block time: ${sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : 'null'}`);
      console.log(`  Error: ${sig.err ? JSON.stringify(sig.err) : 'none'}`);

      let tx;
      try {
        tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
      } catch (e) {
        console.log(`  Failed to fetch tx: ${e}`);
        continue;
      }

      if (!tx) { console.log('  TX is null'); continue; }

      const meta = tx.meta;
      const message = tx.transaction.message;

      // Account keys
      const accountKeys = message.accountKeys.map((k) =>
        typeof k === 'string' ? k : k.pubkey.toBase58()
      );
      console.log(`  Account keys (${accountKeys.length}):`);
      accountKeys.slice(0, 8).forEach((k, j) => {
        const isFac = k === addr ? ' ← FACILITATOR' : '';
        console.log(`    [${j}] ${k}${isFac}`);
      });
      if (accountKeys.length > 8) console.log(`    ... +${accountKeys.length - 8} more`);

      // Program IDs invoked
      const instructions = message.instructions;
      console.log(`  Instructions (${instructions.length}):`);
      for (const ix of instructions) {
        const progId = 'programId' in ix ? ix.programId.toBase58() : 'unknown';
        const parsed = 'parsed' in ix ? ix.parsed : null;
        if (parsed) {
          const type = typeof parsed === 'object' && parsed !== null && 'type' in parsed ? (parsed as { type: string }).type : '?';
          const info = typeof parsed === 'object' && parsed !== null && 'info' in parsed ? (parsed as { info: unknown }).info : null;
          console.log(`    Program: ${progId}`);
          console.log(`    Type: ${type}`);
          if (info && typeof info === 'object') {
            const infoObj = info as Record<string, unknown>;
            // Show key fields for token transfers
            if (infoObj.mint) console.log(`    Mint: ${infoObj.mint}`);
            if (infoObj.source) console.log(`    Source: ${infoObj.source}`);
            if (infoObj.destination) console.log(`    Destination: ${infoObj.destination}`);
            if (infoObj.authority) console.log(`    Authority: ${infoObj.authority}`);
            if (infoObj.amount) console.log(`    Amount: ${infoObj.amount}`);
            if (infoObj.tokenAmount) console.log(`    TokenAmount: ${JSON.stringify(infoObj.tokenAmount)}`);
            if (infoObj.lamports) console.log(`    Lamports: ${infoObj.lamports}`);
          }
        } else {
          console.log(`    Program: ${progId} (not parsed)`);
          if ('data' in ix) {
            const data = (ix as { data: string }).data;
            console.log(`    Data: ${typeof data === 'string' ? data.slice(0, 40) + '...' : '(binary)'}`);
          }
        }
      }

      // Inner instructions (CPI calls)
      const innerIxs = meta?.innerInstructions ?? [];
      if (innerIxs.length > 0) {
        console.log(`  Inner instructions (CPI): ${innerIxs.length} groups`);
        for (const group of innerIxs) {
          for (const iix of group.instructions) {
            const progId = 'programId' in iix ? iix.programId.toBase58() : 'unknown';
            const parsed = 'parsed' in iix ? iix.parsed : null;
            if (parsed && typeof parsed === 'object' && parsed !== null) {
              const p = parsed as Record<string, unknown>;
              const type = p.type as string ?? '?';
              const info = p.info as Record<string, unknown> | undefined;
              if (type === 'transfer' || type === 'transferChecked') {
                console.log(`    CPI ${type}:`);
                if (info?.mint) console.log(`      Mint: ${info.mint}`);
                if (info?.source) console.log(`      Source: ${info.source}`);
                if (info?.destination) console.log(`      Destination: ${info.destination}`);
                if (info?.authority) console.log(`      Authority: ${info.authority}`);
                if (info?.amount) console.log(`      Amount: ${info.amount}`);
                if (info?.tokenAmount) console.log(`      TokenAmount: ${JSON.stringify(info.tokenAmount)}`);
                const isUsdc = info?.mint === USDC_MINT;
                console.log(`      Is USDC: ${isUsdc}`);
              }
            }
          }
        }
      }

      // Token balance changes
      const preBalances = meta?.preTokenBalances ?? [];
      const postBalances = meta?.postTokenBalances ?? [];
      const usdcChanges = postBalances
        .filter((p) => p.mint === USDC_MINT)
        .map((post) => {
          const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
          const preAmt = pre?.uiTokenAmount.uiAmount ?? 0;
          const postAmt = post.uiTokenAmount.uiAmount ?? 0;
          const delta = postAmt - preAmt;
          return {
            owner: post.owner ?? 'unknown',
            preAmt,
            postAmt,
            delta,
            isFacilitator: post.owner === addr,
          };
        })
        .filter((c) => c.delta !== 0);

      if (usdcChanges.length > 0) {
        console.log(`  USDC balance changes:`);
        for (const c of usdcChanges) {
          const marker = c.isFacilitator ? ' ← FACILITATOR' : '';
          console.log(`    ${c.owner?.slice(0, 12)}... : ${c.preAmt} → ${c.postAmt} (Δ${c.delta > 0 ? '+' : ''}${c.delta.toFixed(6)})${marker}`);
        }
      } else {
        console.log(`  No USDC balance changes detected`);
        // Show ALL token changes for debugging
        const allChanges = postBalances.map((post) => {
          const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
          return {
            mint: post.mint,
            owner: post.owner,
            pre: pre?.uiTokenAmount.uiAmount ?? 0,
            post: post.uiTokenAmount.uiAmount ?? 0,
          };
        }).filter((c) => c.pre !== c.post);

        if (allChanges.length > 0) {
          console.log(`  Other token changes:`);
          for (const c of allChanges) {
            console.log(`    Mint: ${c.mint?.slice(0, 12)}... Owner: ${c.owner?.slice(0, 12)}... ${c.pre} → ${c.post}`);
          }
        } else {
          console.log(`  No token balance changes at all`);
        }
      }
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}

inspect().then(() => {
  console.log('\n\nDone.');
  process.exit(0);
}).catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
