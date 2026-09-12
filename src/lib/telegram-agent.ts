import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { handleMessageSend } from '@/app/a2a/route';
import { checkRateLimit } from '@/lib/rate-limit';
import { buildAgentMessage, parseAgentReply } from '@/lib/agent-query';

const UPDATE_TTL = 10 * 60_000;
const MAX_ENTRIES = 2048;
const MAX_BODY = 16_384;
const WELCOME = `I'm AgentKarma. Send a wallet address or an AgentKarma profile link to check Provider + Consumer Karma and the evidence behind them.

Try: agentId 9058 on celo
For EVM addresses, add celo or arc. Use a wallet address for Solana or Stellar.

/karma <wallet, agent ID, or profile link>
/help — show this guide

Scores include a confidence label. Registration alone is not an endorsement.
https://agentkarma.io/meet-agentkarma`;

const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z.object({
    message_id: z.number().int().positive().safe(),
    from: z.object({ id: z.number().int().positive().safe(), is_bot: z.boolean() }).optional(),
    chat: z.object({ id: z.number().int().safe(), type: z.string() }),
    text: z.string().max(4096).optional(),
  }).optional(),
});

export interface TelegramDeps {
  secret: () => string | undefined;
  now: () => number;
  updates: Map<number, number>;
  cooldowns: Map<number, number>;
  inFlight: Set<number>;
  limit: (identifier: string) => Promise<{ success: boolean }>;
  query: (id: string, message: ReturnType<typeof buildAgentMessage>) => Promise<Response>;
}

const defaults: TelegramDeps = {
  secret: () => process.env.TELEGRAM_AGENT_WEBHOOK_SECRET,
  now: Date.now,
  updates: new Map(), cooldowns: new Map(), inFlight: new Set(),
  limit: (id) => checkRateLimit('score', id),
  query: (id, message) => handleMessageSend(id, { message }),
};

function acknowledged() { return Response.json({ ok: true }); }
function unavailable() { return Response.json({ error: 'Agent temporarily unavailable' }, { status: 503 }); }

/** Telegram executes this response as sendMessage; it supplies no delivery receipt. */
function reply(chatId: number, text: string) {
  return Response.json({
    method: 'sendMessage', chat_id: chatId, text: text.slice(0, 4000),
    link_preview_options: { is_disabled: true },
  });
}

function authorized(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get('x-telegram-bot-api-secret-token') ?? '');
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readUpdate(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('oversized'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

function scoreLine(label: string, face: unknown) {
  const data = typeof face === 'object' && face !== null ? face as Record<string, unknown> : {};
  const score = typeof data.score === 'number' && Number.isFinite(data.score) && data.score >= 0 && data.score <= 100
    ? `${data.score}/100` : 'Unrated';
  const badges: Record<string, string> = { declared: 'Declared', 'receipt-backed': 'Receipt-backed', 'behavior-inferred': 'Behavior-inferred' };
  const confidence = typeof data.confidenceBadge === 'string' && Object.hasOwn(badges, data.confidenceBadge)
    ? badges[data.confidenceBadge] : 'Unavailable';
  return `${label}: ${score}\nConfidence: ${confidence}`;
}

function formatReply(result: ReturnType<typeof parseAgentReply>) {
  if (!result.found) return `${result.text}\n\nTry another wallet or an agent ID with celo or arc.`;
  const chain = typeof result.data.chain === 'string' && ['solana', 'stellar', 'celo', 'arc'].includes(result.data.chain)
    ? ` · ${result.data.chain === 'arc' ? 'Arc testnet' : result.data.chain}` : '';
  return [
    `AgentKarma${chain}`,
    scoreLine('Provider', result.data.provider),
    scoreLine('Consumer', result.data.consumer),
    'Confidence describes the evidence behind the score. Declared identity alone is not an endorsement.',
    result.profilePath ? `Evidence and profile: https://agentkarma.io${result.profilePath}` : 'https://agentkarma.io/explore',
  ].join('\n\n');
}

async function boundedQuery(deps: TelegramDeps, id: string, message: ReturnType<typeof buildAgentMessage>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.query(id, message),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 12_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function handleTelegram(request: Request, deps: TelegramDeps = defaults): Promise<Response> {
  const secret = deps.secret();
  if (!secret) return unavailable();
  if (!authorized(request, secret)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'Expected JSON' }, { status: 415 });
  }
  let input: unknown;
  try { input = await readUpdate(request); } catch (error) {
    return Response.json({ error: 'Invalid update' }, { status: error instanceof Error && error.message === 'oversized' ? 413 : 400 });
  }
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: 'Invalid update' }, { status: 400 });
  const { update_id: updateId, message } = parsed.data;
  if (!message || message.chat.type !== 'private' || !message.from || message.from.is_bot || message.from.id !== message.chat.id) return acknowledged();
  const now = deps.now();
  // Bounded, single-process replay protection. It intentionally makes no
  // exactly-once promise across restarts or multiple application replicas.
  for (const [id, at] of deps.updates) if (now - at >= UPDATE_TTL) deps.updates.delete(id);
  for (const [id, at] of deps.cooldowns) if (now - at >= 1000) deps.cooldowns.delete(id);
  if (deps.updates.has(updateId) || deps.inFlight.has(updateId)) return acknowledged();
  const user = message.from.id;
  if (deps.cooldowns.has(user)) return acknowledged();
  // Historical updates must never consume active-work capacity. Cooldown drops
  // aren't cached: a burst from one sender cannot fill the global replay cache.
  if (deps.inFlight.size >= 64 || deps.cooldowns.size >= MAX_ENTRIES) return unavailable();
  deps.inFlight.add(updateId); // Claim before the first await.
  deps.cooldowns.set(user, now);
  let retryable = false;
  try {
    const limit = await deps.limit(`telegram:${user}`);
    if (!limit.success) return reply(message.chat.id, 'Too many queries. Wait a minute and try again.');
    const text = message.text?.trim() ?? '';
    const command = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (command?.[2] && command[2].toLowerCase() !== 'agentkarmabot') return acknowledged();
    if (!text || (command && (command[1].toLowerCase() !== 'karma' || !command[3]?.trim()))) {
      return reply(message.chat.id, WELCOME);
    }
    const query = command ? command[3] : text;
    const id = `telegram-${updateId}`;
    let agentMessage: ReturnType<typeof buildAgentMessage>;
    try { agentMessage = buildAgentMessage(query, id); } catch (error) {
      return reply(message.chat.id, error instanceof Error ? error.message : 'Send a wallet or AgentKarma profile link.');
    }
    const response = await boundedQuery(deps, id, agentMessage);
    if (!response.ok) throw new Error('query failed');
    const result = parseAgentReply(await response.json(), id);
    return reply(message.chat.id, formatReply(result));
  } catch {
    // Returning non-2xx permits Telegram to retry; do not retain a failed claim.
    // Never log the incoming message, secret, or resolver exception.
    retryable = true;
    if (deps.cooldowns.get(user) === now) deps.cooldowns.delete(user);
    return unavailable();
  } finally {
    deps.inFlight.delete(updateId);
    if (!retryable) {
      if (deps.updates.size >= MAX_ENTRIES) {
        const oldest = deps.updates.keys().next().value;
        if (oldest !== undefined) deps.updates.delete(oldest);
      }
      deps.updates.set(updateId, now);
    }
  }
}
