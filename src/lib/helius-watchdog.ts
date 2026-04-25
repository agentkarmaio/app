/**
 * Helius webhook watchdog — keeps our enhanced webhook self-healing.
 *
 * Helius auto-disables a webhook after 24h of 100% delivery failures. The
 * deferred-scoring fix removed the failure mode that caused the 2026-04-23
 * incident, but we still want the webhook to recover automatically from any
 * new cause (deploy 504, network blip, manual mistake). This watchdog polls
 * the Helius API on an interval and PUTs `active: true` back when it sees
 * the webhook disabled.
 *
 * The watchdog discovers the webhook by URL match — no hardcoded webhookID,
 * so a recreate (e.g. via `bun run src/scripts/setup-webhook.ts`) keeps
 * working without code changes.
 *
 * Tunables:
 *   HELIUS_WATCHDOG_INTERVAL_MS  default 300_000  (5 min)
 *   HELIUS_WATCHDOG_DISABLED     "1" to skip
 *   HELIUS_WATCHDOG_URL_HINT     URL substring to match (default agentkarma.io/api/webhook/helius)
 */
const DEFAULT_URL_HINT = 'agentkarma.io/api/webhook/helius';
const HELIUS_WEBHOOK_API = 'https://api-mainnet.helius-rpc.com/v0/webhooks';

interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  webhookType: string;
  accountAddresses: string[];
  transactionTypes: string[];
  authHeader?: string;
  active: boolean;
  disabledReason?: string;
  disabledAt?: string;
}

function getApiKey(): string | null {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const url = process.env.HELIUS_RPC_URL;
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('api-key');
  } catch {
    return null;
  }
}

async function listWebhooks(apiKey: string): Promise<HeliusWebhook[]> {
  const r = await fetch(`${HELIUS_WEBHOOK_API}?api-key=${apiKey}`);
  if (!r.ok) throw new Error(`Helius listWebhooks ${r.status}`);
  return (await r.json()) as HeliusWebhook[];
}

async function reEnable(apiKey: string, hook: HeliusWebhook): Promise<void> {
  const body = {
    webhookURL: hook.webhookURL,
    webhookType: hook.webhookType,
    accountAddresses: hook.accountAddresses,
    transactionTypes: hook.transactionTypes,
    authHeader: hook.authHeader,
    active: true,
  };
  const r = await fetch(`${HELIUS_WEBHOOK_API}/${hook.webhookID}?api-key=${apiKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`Helius PUT webhook ${hook.webhookID} → ${r.status}: ${await r.text()}`);
  }
}

export interface WatchdogTick {
  matched: number;
  active: number;
  reEnabled: { id: string; reason?: string }[];
  errors: string[];
}

export async function checkOnce(urlHint = DEFAULT_URL_HINT): Promise<WatchdogTick | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  const hooks = await listWebhooks(apiKey);
  const matched = hooks.filter((h) => h.webhookURL?.includes(urlHint));
  const tick: WatchdogTick = {
    matched: matched.length,
    active: matched.filter((h) => h.active).length,
    reEnabled: [],
    errors: [],
  };
  for (const h of matched) {
    if (h.active) continue;
    try {
      await reEnable(apiKey, h);
      tick.reEnabled.push({ id: h.webhookID, reason: h.disabledReason });
    } catch (err) {
      tick.errors.push(`${h.webhookID}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return tick;
}

export function startWatchdog(): void {
  if (process.env.HELIUS_WATCHDOG_DISABLED === '1') {
    console.log('[helius-watchdog] disabled via env');
    return;
  }
  if (!getApiKey()) {
    console.log('[helius-watchdog] no HELIUS_API_KEY / HELIUS_RPC_URL — skipping');
    return;
  }
  const intervalMs = Number(process.env.HELIUS_WATCHDOG_INTERVAL_MS) || 300_000;
  const urlHint = process.env.HELIUS_WATCHDOG_URL_HINT || DEFAULT_URL_HINT;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await checkOnce(urlHint);
      if (!result) return;
      if (result.reEnabled.length > 0) {
        for (const r of result.reEnabled) {
          console.log(
            `[helius-watchdog] re-enabled webhook ${r.id} (was: ${r.reason ?? 'unknown'})`,
          );
        }
      }
      if (result.errors.length > 0) {
        for (const e of result.errors) {
          console.error(`[helius-watchdog] error: ${e}`);
        }
      }
      if (result.matched === 0) {
        console.warn(`[helius-watchdog] no webhook matched URL hint "${urlHint}"`);
      }
    } catch (err) {
      console.error('[helius-watchdog] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[helius-watchdog] registered · interval=${intervalMs}ms url_hint="${urlHint}"`);
  // Prime an immediate check on boot so a webhook disabled mid-deploy
  // recovers as soon as the new replica is live.
  void tick();
}
