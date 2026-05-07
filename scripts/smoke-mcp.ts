#!/usr/bin/env bun
/**
 * Smoke test for the AgentKarma MCP server.
 *
 *   bun run scripts/smoke-mcp.ts                 # local dev (http://localhost:3737/mcp)
 *   bun run scripts/smoke-mcp.ts <wallet>        # run get_karma against a real wallet
 *   MCP_URL=https://agentkarma.io/mcp bun run scripts/smoke-mcp.ts
 *
 * Spawns no server — assumes `bun dev` (or production) is already running.
 *
 * Drives the server over a stateless `streamable-http` request using only
 * `fetch` + the MCP JSON-RPC envelope. We parse the SSE response by hand so
 * the script has no extra deps.
 */

const ENDPOINT = process.env.MCP_URL ?? 'http://localhost:3737/mcp';
const WALLET = process.argv[2];

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse<T>> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    ...(params ? { params } : {}),
  });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The MCP streamable-http transport defaults to SSE responses but will
      // also accept a plain JSON envelope when only application/json is asked.
      Accept: 'application/json, text/event-stream',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return (await res.json()) as JsonRpcResponse<T>;
  }

  // SSE: read the stream and pull out the first `data:` payload that decodes
  // as a JSON-RPC response with our id.
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse<T>;
      if (parsed.jsonrpc === '2.0') return parsed;
    } catch { /* keep scanning */ }
  }
  throw new Error(`No JSON-RPC response found in SSE body:\n${text}`);
}

async function initialize(): Promise<void> {
  const res = await rpc<{ serverInfo: { name: string; version: string } }>('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agentkarma-smoke', version: '0.0.1' },
  });
  if (res.error) throw new Error(`initialize failed: ${res.error.message}`);
  console.log('initialize ok:', res.result?.serverInfo);
}

async function listTools(): Promise<string[]> {
  const res = await rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list');
  if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
  const tools = res.result?.tools ?? [];
  console.log(`tools/list: ${tools.length} tool(s)`);
  for (const t of tools) console.log(`  - ${t.name} :: ${t.description ?? ''}`);
  return tools.map((t) => t.name);
}

async function callGetKarma(wallet: string): Promise<void> {
  const res = await rpc<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>(
    'tools/call',
    {
      name: 'get_karma',
      arguments: { wallet },
    },
  );
  if (res.error) throw new Error(`tools/call failed: ${res.error.message}`);
  const r = res.result;
  console.log(`get_karma(${wallet}) isError=${Boolean(r?.isError)}`);
  for (const c of r?.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') {
      console.log(c.text);
    }
  }
}

async function main(): Promise<void> {
  console.log(`AgentKarma MCP smoke -> ${ENDPOINT}`);
  await initialize();
  const tools = await listTools();
  const expected = [
    'get_karma',
    'get_provider_karma',
    'get_consumer_karma',
    'get_confidence',
    'search_agents',
    'get_attestations',
  ];
  const missing = expected.filter((t) => !tools.includes(t));
  if (missing.length > 0) {
    throw new Error(`Missing tools: ${missing.join(', ')}`);
  }
  console.log('all expected tools present');

  if (WALLET) {
    await callGetKarma(WALLET);
  } else {
    console.log('(skip) pass a wallet as argv[2] to test get_karma against real data');
  }
  console.log('OK');
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
