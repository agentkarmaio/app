/// <reference types="bun-types" />
/**
 * Unit tests for the MCP wallet schema + Stellar tool registration.
 *
 * Run: bun test src/app/mcp/mcp-tools.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { walletSchema, chainSchema, chainFilterSchema, listRegisteredToolNames, intParam, runTool, POST } from './route';

const SOLANA = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ';      // 44 chars
const STELLAR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'; // 56 chars
const EVM = '0x8004A818BFB912233c491871b3d84c89A494BD9e';            // 42 chars

describe('walletSchema', () => {
  test('accepts a Solana base58 address (44 chars)', () => {
    expect(walletSchema.safeParse(SOLANA).success).toBe(true);
  });

  test('accepts a Stellar StrKey address (56 chars)', () => {
    expect(walletSchema.safeParse(STELLAR).success).toBe(true);
  });

  test('rejects too-short strings (<32)', () => {
    expect(walletSchema.safeParse('abc').success).toBe(false);
  });

  test('rejects too-long strings (>56)', () => {
    expect(walletSchema.safeParse('G'.repeat(57)).success).toBe(false);
  });

  test('accepts an EVM 0x address (42 chars, Arc)', () => {
    expect(walletSchema.safeParse('0x8004A818BFB912233c491871b3d84c89A494BD9e').success).toBe(true);
  });
});

describe('chainSchema (optional chain declaration)', () => {
  test('accepts each supported chain', () => {
    for (const c of ['solana', 'celo', 'stellar', 'arc']) {
      expect(chainSchema.safeParse(c).success).toBe(true);
    }
  });

  test('passes when absent (undefined) — chain is optional', () => {
    const r = chainSchema.safeParse(undefined);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBeUndefined();
  });

  test('rejects an unsupported chain ("ethereum")', () => {
    expect(chainSchema.safeParse('ethereum').success).toBe(false);
  });
});

describe('chainFilterSchema (optional chain filter for non-address tools)', () => {
  test('accepts each supported chain', () => {
    for (const c of ['solana', 'celo', 'stellar', 'arc']) {
      expect(chainFilterSchema.safeParse(c).success).toBe(true);
    }
  });

  test('passes when absent (undefined) — filter is optional', () => {
    const r = chainFilterSchema.safeParse(undefined);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBeUndefined();
  });

  test('rejects an unsupported chain ("polygon")', () => {
    expect(chainFilterSchema.safeParse('polygon').success).toBe(false);
  });
});

describe('tool registration — full 14-tool READ surface', () => {
  const EXPECTED = [
    'get_karma',
    'get_provider_karma',
    'get_consumer_karma',
    'get_confidence',
    'search_agents',
    'get_attestations',
    'get_celo_agent',
    'get_stellar_karma',
    'get_arc_karma',
    // The 5 added here:
    'get_score_history',
    'get_leaderboard',
    'get_stats',
    'get_succession',
    'get_bond',
  ];

  test('all 14 tools are registered (no more, no fewer)', () => {
    const names = listRegisteredToolNames();
    for (const n of EXPECTED) expect(names).toContain(n);
    expect(names).toHaveLength(14);
  });

  test('get_stellar_karma is registered alongside get_karma and get_celo_agent', () => {
    const names = listRegisteredToolNames();
    expect(names).toContain('get_karma');
    expect(names).toContain('get_celo_agent');
    expect(names).toContain('get_stellar_karma');
    expect(names).toContain('get_arc_karma');
  });
});

// ── Numeric param coercion (string → number) ──────────────────────────────
// Regression: LLM clients / mcpplaygroundonline.com send numbers as JSON
// strings, e.g. {"agentId": "9263"}. The strict z.number() schemas used to
// reject these with MCP -32602 "Expected number, received string". intParam()
// coerces string→number at parse-time while still rejecting genuine garbage.
// These schemas are the exact ones wired into get_celo_agent / search_agents /
// get_attestations (mcp.js safeParseAsync — the gate that emitted -32602).

describe('intParam — get_celo_agent.agentId (intParam().positive())', () => {
  const agentId = intParam().positive();

  test('accepts numeric STRING "9263" → 9263', () => {
    const r = agentId.safeParse('9263');
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe(9263);
  });

  test('accepts number 9263 (back-compat)', () => {
    const r = agentId.safeParse(9263);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe(9263);
  });

  test('rejects non-numeric "abc" (NaN)', () => {
    expect(agentId.safeParse('abc').success).toBe(false);
  });

  test('rejects non-integer string "9263.5" (.int())', () => {
    expect(agentId.safeParse('9263.5').success).toBe(false);
  });

  test('rejects "-1" and "0" (.positive())', () => {
    expect(agentId.safeParse('-1').success).toBe(false);
    expect(agentId.safeParse('0').success).toBe(false);
  });

  test('rejects empty string "" (coerces to 0, fails .positive())', () => {
    expect(agentId.safeParse('').success).toBe(false);
  });
});

describe('intParam — search_agents.limit (intParam().min(1).max(50).optional())', () => {
  const limit = intParam().min(1).max(50).optional();

  test('accepts numeric STRING "8" → 8', () => {
    const r = limit.safeParse('8');
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe(8);
  });

  test('accepts number 8', () => {
    expect(limit.safeParse(8).success).toBe(true);
  });

  test('passes when absent (undefined) — optional is outermost', () => {
    const r = limit.safeParse(undefined);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBeUndefined();
  });

  test('rejects over-max "51" (.max(50))', () => {
    expect(limit.safeParse('51').success).toBe(false);
  });

  test('rejects "0" (.min(1))', () => {
    expect(limit.safeParse('0').success).toBe(false);
  });

  test('rejects "abc"', () => {
    expect(limit.safeParse('abc').success).toBe(false);
  });
});

describe('intParam — get_attestations.limit (intParam().min(1).max(200).optional())', () => {
  const limit = intParam().min(1).max(200).optional();

  test('accepts numeric STRING "200" → 200', () => {
    const r = limit.safeParse('200');
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe(200);
  });

  test('passes when absent (undefined)', () => {
    expect(limit.safeParse(undefined).success).toBe(true);
  });

  test('rejects over-max "201" (.max(200))', () => {
    expect(limit.safeParse('201').success).toBe(false);
  });
});

// ── POST handler — JSON-RPC tools/call reaches the handler with string id ──
// Proves end-to-end that {"agentId": "9263"} no longer trips the -32602
// validation gate. The MCP SDK surfaces validation failures as a successful
// JSON-RPC `result` carrying `isError: true` and the "-32602 … Expected
// number" text inside content[0].text (not as a top-level `error`). So we
// detect the validation rejection by scanning the tool-result text.

function rpcCall(name: string, args: unknown) {
  return POST(
    new Request('https://agentkarma.io/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
}

type RpcEnvelope = {
  error?: { code: number; message: string };
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
};

async function parseRpc(res: Response): Promise<RpcEnvelope> {
  const text = await res.text();
  // Streamable-HTTP answers as SSE (text/event-stream): pull the `data:` line.
  const dataLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'));
  const raw = dataLine ? dataLine.slice('data:'.length).trim() : text.trim();
  return JSON.parse(raw);
}

/** True iff the response is the SDK's -32602 argument-validation rejection. */
function isValidationError(env: RpcEnvelope): boolean {
  if (env.error?.code === -32602) return true;
  const txt = env.result?.content?.map((c) => c.text ?? '').join('') ?? '';
  return env.result?.isError === true && txt.includes('-32602');
}

describe('POST get_celo_agent with agentId as STRING "9263"', () => {
  test('does NOT return the -32602 validation error (reaches the handler)', async () => {
    const res = await rpcCall('get_celo_agent', { agentId: '9263' });
    const env = await parseRpc(res);
    // The fix: string "9263" passes validation. Any downstream outcome (real
    // record, clean not_found, or a network/internal error) is acceptable —
    // what must NOT happen is the InvalidParams "Expected number" rejection.
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('agentId "abc" is still rejected as an argument-validation error', async () => {
    const res = await rpcCall('get_celo_agent', { agentId: 'abc' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(true);
  }, 30_000);
});

// ── Chain-aware get_karma — EVM 0x address with a chain hint ────────────────
// Regression for the core bug: an EVM (Celo/Arc) address used to resolve against
// the wrong (chain,address) composite-PK row because resolveKarma → getWallet
// defaults to chain='solana'. With the chain-aware dispatcher, get_karma(addr,
// "celo") MUST route to the Celo EVM snapshot path — NEVER mis-resolve to a
// Solana-shaped success.
//
// The test DB may or may not hold a row for this address; both downstream
// outcomes are acceptable:
//   - clean not_found error (no Celo row), OR
//   - an EVM-shaped result carrying "chain":"celo".
// What must NEVER happen: a non-error result that resolved as Solana (no
// "chain":"celo"), which is exactly the wrong-chain mis-resolution we fixed.

/** Pull the single text payload from a tool result (or empty string). */
function resultText(env: RpcEnvelope): string {
  return env.result?.content?.map((c) => c.text ?? '').join('') ?? '';
}

describe('POST get_karma with an EVM address + chain hint "celo"', () => {
  test('does NOT pass a validation error (chain "celo" is accepted)', async () => {
    const res = await rpcCall('get_karma', { wallet: EVM, chain: 'celo' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('never mis-resolves to a Solana-shaped success — any success carries chain:"celo"', async () => {
    const res = await rpcCall('get_karma', { wallet: EVM, chain: 'celo' });
    const env = await parseRpc(res);
    const txt = resultText(env);
    const isError = env.result?.isError === true || env.error != null;
    if (!isError) {
      // A successful resolution of an EVM address MUST be the Celo path.
      const parsed = JSON.parse(txt) as { chain?: string };
      expect(parsed.chain).toBe('celo');
    }
    // Either way, the success must not silently be a Solana resolution.
    if (!isError) {
      expect(txt).not.toContain('"chain": "solana"');
    }
  }, 30_000);

  test('rejects an unsupported chain value ("ethereum")', async () => {
    const res = await rpcCall('get_karma', { wallet: EVM, chain: 'ethereum' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(true);
  }, 30_000);
});

// ── New READ tools — limit coercion (string → number) ──────────────────────
// Same regression surface as the existing intParam tests: LLM clients send
// limits as JSON strings. These are the exact schemas wired into the new tools.

describe('intParam — get_score_history.limit (intParam().min(1).max(200).optional())', () => {
  const limit = intParam().min(1).max(200).optional();

  test('accepts numeric STRING "30" → 30', () => {
    const r = limit.safeParse('30');
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe(30);
  });

  test('passes when absent (undefined)', () => {
    expect(limit.safeParse(undefined).success).toBe(true);
  });

  test('rejects over-max "201" (.max(200))', () => {
    expect(limit.safeParse('201').success).toBe(false);
  });
});

describe('intParam — get_leaderboard.limit (intParam().min(1).max(50).optional())', () => {
  const limit = intParam().min(1).max(50).optional();

  test('accepts numeric STRING "10" → 10', () => {
    const r = limit.safeParse('10');
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe(10);
  });

  test('rejects over-max "51" (.max(50))', () => {
    expect(limit.safeParse('51').success).toBe(false);
  });

  test('rejects "0" (.min(1))', () => {
    expect(limit.safeParse('0').success).toBe(false);
  });
});

// ── POST tools/call — each new tool registers + returns a clean shape ──────
// Against the unseeded test DB these resolve to clean not-found / empty
// aggregates. What must hold for every call: (1) it is NOT a -32602 argument-
// validation rejection (the tool exists + the args parse), and (2) the
// resolved payload is the expected shape (not a wrong-tool or schema error).

describe('POST get_score_history (wallet, limit as STRING)', () => {
  test('limit "5" passes validation — string coerces to number', async () => {
    const res = await rpcCall('get_score_history', { wallet: SOLANA, limit: '5' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('returns either a clean wallet_not_found or a points-shaped trend', async () => {
    const res = await rpcCall('get_score_history', { wallet: SOLANA });
    const env = await parseRpc(res);
    const txt = resultText(env);
    const isError = env.result?.isError === true || env.error != null;
    if (isError) {
      expect(txt).toContain('wallet_not_found');
    } else {
      const parsed = JSON.parse(txt) as { points?: unknown[]; count?: number };
      expect(Array.isArray(parsed.points)).toBe(true);
    }
  }, 30_000);
});

describe('POST get_leaderboard (chain filter + limit)', () => {
  test('chain "solana" + limit "5" pass validation', async () => {
    const res = await rpcCall('get_leaderboard', { chain: 'solana', limit: '5' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('returns an agents-array shape (top-ranked)', async () => {
    const res = await rpcCall('get_leaderboard', { limit: '5' });
    const env = await parseRpc(res);
    const isError = env.result?.isError === true || env.error != null;
    // A leaderboard read never not-founds on a missing wallet; it should resolve.
    if (!isError) {
      const parsed = JSON.parse(resultText(env)) as { agents?: unknown[] };
      expect(Array.isArray(parsed.agents)).toBe(true);
    }
  }, 30_000);

  test('rejects an unsupported chain filter ("polygon")', async () => {
    const res = await rpcCall('get_leaderboard', { chain: 'polygon' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(true);
  }, 30_000);
});

describe('POST get_stats (no required params)', () => {
  test('reaches the handler with no args (not a validation error)', async () => {
    const res = await rpcCall('get_stats', {});
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('returns the aggregate shape (totalAgents / tierDistribution)', async () => {
    const res = await rpcCall('get_stats', {});
    const env = await parseRpc(res);
    const isError = env.result?.isError === true || env.error != null;
    if (!isError) {
      const parsed = JSON.parse(resultText(env)) as {
        totalAgents?: number; tierDistribution?: Record<string, number>;
      };
      expect(typeof parsed.totalAgents).toBe('number');
      expect(typeof parsed.tierDistribution).toBe('object');
    }
  }, 30_000);
});

describe('POST get_succession (wallet, chain?)', () => {
  test('wallet + chain "solana" pass validation', async () => {
    const res = await rpcCall('get_succession', { wallet: SOLANA, chain: 'solana' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('returns no_succession_plan or a succession view (unseeded DB)', async () => {
    const res = await rpcCall('get_succession', { wallet: SOLANA });
    const env = await parseRpc(res);
    const txt = resultText(env);
    const isError = env.result?.isError === true || env.error != null;
    if (isError) {
      expect(txt).toContain('no_succession_plan');
    } else {
      const parsed = JSON.parse(txt) as { succession?: unknown };
      expect(parsed.succession).toBeDefined();
    }
  }, 30_000);
});

describe('POST get_bond (wallet, chain?)', () => {
  test('wallet + chain "celo" pass validation (EVM address)', async () => {
    const res = await rpcCall('get_bond', { wallet: EVM, chain: 'celo' });
    const env = await parseRpc(res);
    expect(isValidationError(env)).toBe(false);
  }, 30_000);

  test('returns no_bond_activity or a bonds/surety view (unseeded DB)', async () => {
    const res = await rpcCall('get_bond', { wallet: SOLANA });
    const env = await parseRpc(res);
    const txt = resultText(env);
    const isError = env.result?.isError === true || env.error != null;
    if (isError) {
      expect(txt).toContain('no_bond_activity');
    } else {
      const parsed = JSON.parse(txt) as { bonds?: unknown };
      expect(parsed.bonds).toBeDefined();
    }
  }, 30_000);
});

// ── Frictionless operability: no tool ever leaks a raw error ────────────────
// Every tool body runs through runTool, which converts ANY thrown error (an
// on-chain contract revert, a transient DB error) into a clean, friendly MCP
// result instead of dumping the raw viem/Postgres stack to the caller.

describe('runTool — universal error backstop (no raw dumps)', () => {
  test('a thrown contract revert becomes a clean not_found — raw viem dump suppressed', async () => {
    const r = await runTool('get_celo_agent', async () => {
      throw new Error(
        'The contract function "tokenURI" reverted with the following signature:\n0x7e273289\nUnable to decode signature "0x7e273289"\nVersion: viem@2.48.11',
      );
    });
    expect(r.isError).toBe(true);
    const txt = r.content.map((c) => c.text).join('');
    const parsed = JSON.parse(txt) as { error: string; tool: string };
    expect(parsed.error).toBe('not_found');
    expect(parsed.tool).toBe('get_celo_agent');
    // The scary raw revert signature / viem version must NEVER reach the caller.
    expect(txt).not.toContain('0x7e273289');
    expect(txt).not.toContain('viem@');
    expect(txt).not.toContain('reverted with the following');
  });

  test('a generic throw becomes a generic tool_error — raw internal error NOT leaked', async () => {
    const r = await runTool('get_leaderboard', async () => {
      throw new Error('connection terminated: postgres://user:pa55w0rd@10.0.0.5:5432/db\n  at PgClient.connect');
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content.map((c) => c.text).join('')) as { error: string; tool: string; message: string };
    expect(parsed.error).toBe('tool_error');
    expect(parsed.tool).toBe('get_leaderboard');
    // SECURITY: no portion of the raw error (creds, host, port, stack) may leak
    // to the public caller — only a generic message.
    expect(parsed.message).not.toContain('connection terminated');
    expect(parsed.message).not.toContain('pa55w0rd');
    expect(parsed.message).not.toContain('10.0.0.5');
    expect(parsed.message).not.toContain('\n');
  });

  test('a normal result passes through untouched', async () => {
    const r = await runTool('get_karma', async () => ({
      content: [{ type: 'text' as const, text: '{"ok":true}' }],
    }));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('{"ok":true}');
  });

  test('a RETURNED (not thrown) error passes through unchanged — not re-wrapped', async () => {
    const r = await runTool('get_karma', async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: '{"error":"wallet_not_found"}' }],
    }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('wallet_not_found');
  });
});

describe('POST get_celo_agent — nonexistent agentId (Image #30 regression)', () => {
  test('a huge unregistered agentId returns a clean not-found, never a raw viem revert dump', async () => {
    const res = await rpcCall('get_celo_agent', { agentId: '999999999' });
    const env = await parseRpc(res);
    const txt = resultText(env);
    // The exact playground friction: get_celo_agent dumped "tokenURI reverted …
    // 0x7e273289 … viem@" for a bad id. It must now be a clean not-found.
    expect(txt).not.toMatch(/reverted with the following|Unable to decode signature|viem@/);
    expect(txt).toMatch(/celo_agent_not_found|not_found/);
  }, 30_000);
});
