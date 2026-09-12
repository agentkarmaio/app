/** Browser-safe input/output contract shared by the web playground and Telegram. */
type Part = { kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> };
const CHAINS = ['solana', 'stellar', 'celo', 'arc'];
const ID = /\bagent(?:\s*-?\s*id)?\s*#?\s*(\d{1,9})\b/i;
const EVM = /\b0x[a-fA-F0-9]{40}\b/;
const CHAIN = /\b(solana|sol|stellar|xlm|celo|arc)\b/i;

function profileUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !['agentkarma.io', 'www.agentkarma.io'].includes(url.hostname)
    || url.username || url.password || url.port || !/^\/agent\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('Paste an AgentKarma profile link or a wallet address.');
  }
  return url;
}

export function buildAgentMessage(input: string, messageId: string) {
  const text = input.trim();
  if (!text || text.length > 4096) throw new Error('Enter a wallet, agent ID, or profile link (up to 4,096 characters).');
  let parts: Part[];
  if (/https?:\/\//i.test(text)) {
    let url: URL;
    try { url = profileUrl(text); } catch { throw new Error('Paste a complete HTTPS AgentKarma profile link.'); }
    const wallet = url.pathname.split('/')[2];
    const hint = url.searchParams.get('chain');
    if (hint && !CHAINS.includes(hint)) throw new Error('Supported chains are Solana, Stellar, Celo and Arc.');
    const chain = hint ?? (/^G[A-Z2-7]{55}$/.test(wallet) ? 'stellar' : EVM.test(wallet) ? null : 'solana');
    if (!chain) throw new Error('Include celo or arc in the profile link to select the network.');
    const rawId = url.searchParams.get('agentId');
    if (rawId !== null && (!/^[1-9]\d{0,8}$/.test(rawId))) throw new Error('The profile has an invalid agent ID.');
    // Stellar/Solana queries resolve by wallet. EVM registry profiles must keep
    // the ID: one controller can own several registered agents.
    parts = [{ kind: 'data', data: rawId && (chain === 'celo' || chain === 'arc')
      ? { agentId: Number(rawId), chain } : { wallet, chain } }];
  } else {
    const id = ID.test(text);
    const chain = CHAIN.exec(text)?.[1].toLowerCase();
    if (id && chain && !['celo', 'arc'].includes(chain) && !EVM.test(text)) {
      throw new Error('Use the wallet address for Stellar or Solana; numeric agent IDs are supported on Celo and Arc.');
    }
    if ((id || EVM.test(text)) && !chain) throw new Error('Include celo or arc with this address or agent ID.');
    parts = [{ kind: 'text', text }];
  }
  return { kind: 'message' as const, role: 'user' as const, messageId, parts };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAgentReply(payload: unknown, requestId: string): {
  text: string; data: Record<string, unknown>; found: boolean; profilePath: string | null;
} {
  const invalid = 'The agent returned an unexpected response. Please try again.';
  if (!record(payload) || payload.jsonrpc !== '2.0' || payload.id !== requestId) throw new Error(invalid);
  if (record(payload.error)) {
    throw new Error(payload.error.code === -32000
      ? 'Too many queries. Wait a minute and try again.'
      : 'The agent could not complete this query. Please try again shortly.');
  }
  const result = payload.result;
  if (!record(result) || result.kind !== 'message' || result.role !== 'agent' || !Array.isArray(result.parts)) throw new Error(invalid);
  const parts = result.parts.filter(record);
  const text = parts.filter((p) => p.kind === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('\n').trim();
  const data = parts.find((p) => p.kind === 'data' && record(p.data))?.data;
  if (!text || !record(data) || (data.found !== false && (!record(data.provider) || !record(data.consumer)))) throw new Error(invalid);
  let profilePath: string | null = null;
  if (typeof data.profileUrl === 'string') {
    try {
      const url = profileUrl(data.profileUrl);
      // Wallet-query responses can carry a bare /agent/address URL. Keep
      // evidence navigation on the same EVM network as the actual result.
      if (data.chain === 'celo' || data.chain === 'arc') {
        url.searchParams.set('chain', data.chain);
        if (typeof data.agentId === 'number' && Number.isSafeInteger(data.agentId) && data.agentId > 0) {
          url.searchParams.set('agentId', String(data.agentId));
        }
      }
      profilePath = url.pathname + url.search;
    } catch { /* Untrusted links never become navigation targets. */ }
  }
  return { text, data, found: data.found !== false, profilePath };
}
