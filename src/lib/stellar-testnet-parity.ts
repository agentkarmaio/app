/**
 * Pure comparison core of scripts/stellar-testnet-parity.ts: AgentKarma's
 * stellar-testnet payment legs vs. an external indexer's CSV export
 * (`op_id, idx, tx_hash, agent_id, payer, amount_usdc, at, counted`, plus the
 * optional `direction` and `excluded_reason`). Amounts are compared as integer
 * base units (USDC has 7 decimals), never as floats.
 */

export interface ParityLeg {
  /** Leg key "<operationId>:<index>" — AgentKarma's `payments[].id`. */
  id: string;
  agentId: number;
  direction: 'received' | 'sent';
  /** USDC base units (1 USDC = 10^7). */
  units: bigint;
  counted: boolean;
  /** Undefined when the source does not carry a reason (skips that comparison). */
  reason?: string | null;
}

export function usdcToUnits(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,7}))?$/.exec(text.trim());
  if (!m) throw new Error(`not a USDC amount with <= 7 decimals: ${text}`);
  return BigInt(m[1]) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0'));
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const TRUE = new Set(['true', 't', '1', 'yes']);

/**
 * CSV record → leg. `agentAddress` resolves direction when the export has no
 * `direction` column: a leg paid BY the agent's address is sent, anything else
 * is received.
 */
export function partnerLeg(rec: Record<string, string>, agentAddress: (agentId: number) => string | undefined): ParityLeg {
  const agentId = Number(rec.agent_id);
  if (!Number.isInteger(agentId)) throw new Error(`bad agent_id in row ${rec.op_id}:${rec.idx}`);
  const direction = rec.direction === 'sent' || rec.direction === 'received'
    ? rec.direction
    : rec.payer === agentAddress(agentId) ? 'sent' : 'received';
  const reason = 'excluded_reason' in rec ? (rec.excluded_reason || null) : undefined;
  return {
    id: `${rec.op_id}:${rec.idx}`, agentId, direction, units: usdcToUnits(rec.amount_usdc),
    counted: TRUE.has(rec.counted.toLowerCase()), ...(reason !== undefined ? { reason } : {}),
  };
}

export interface ParityTotals { received: bigint; sent: bigint; counted: bigint; legs: number }

export interface ParityReport {
  mismatches: string[];
  /** Per agent: [AgentKarma, partner]. */
  totals: Map<number, [ParityTotals, ParityTotals]>;
}

function totalsOf(legs: ParityLeg[]): ParityTotals {
  const t: ParityTotals = { received: 0n, sent: 0n, counted: 0n, legs: legs.length };
  for (const l of legs) {
    if (l.direction === 'received') t.received += l.units; else t.sent += l.units;
    if (l.counted) t.counted += l.units;
  }
  return t;
}

export function compareLegs(ak: ParityLeg[], partner: ParityLeg[]): ParityReport {
  const mismatches: string[] = [];
  const akById = new Map(ak.map((l) => [l.id, l]));
  const partnerById = new Map(partner.map((l) => [l.id, l]));
  for (const [id, p] of partnerById) {
    const a = akById.get(id);
    if (!a) { mismatches.push(`${id}: missing in AgentKarma (agent ${p.agentId})`); continue; }
    const diffs: string[] = [];
    if (a.agentId !== p.agentId) diffs.push(`agent ${a.agentId} vs ${p.agentId}`);
    if (a.direction !== p.direction) diffs.push(`direction ${a.direction} vs ${p.direction}`);
    if (a.units !== p.units) diffs.push(`amount ${a.units} vs ${p.units} units`);
    if (a.counted !== p.counted) diffs.push(`counted ${a.counted} vs ${p.counted}`);
    if (p.reason !== undefined && (a.reason ?? null) !== p.reason) diffs.push(`reason ${a.reason ?? null} vs ${p.reason}`);
    if (diffs.length) mismatches.push(`${id}: ${diffs.join('; ')}`);
  }
  for (const [id, a] of akById) if (!partnerById.has(id)) mismatches.push(`${id}: missing in partner export (agent ${a.agentId})`);

  const agents = new Set([...ak, ...partner].map((l) => l.agentId));
  const totals = new Map<number, [ParityTotals, ParityTotals]>();
  for (const agent of [...agents].sort((x, y) => x - y)) {
    const pair: [ParityTotals, ParityTotals] = [
      totalsOf(ak.filter((l) => l.agentId === agent)), totalsOf(partner.filter((l) => l.agentId === agent)),
    ];
    totals.set(agent, pair);
    for (const key of ['received', 'sent', 'counted'] as const) {
      if (pair[0][key] !== pair[1][key]) mismatches.push(`agent ${agent}: ${key} total ${pair[0][key]} vs ${pair[1][key]} units`);
    }
  }
  return { mismatches, totals };
}
