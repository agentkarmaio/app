'use client';

/**
 * EvmWalletProvider — injected EVM wallet connection for Celo / Arc, the
 * parallel of SolanaWalletProvider. Uses raw EIP-6963 (multi-wallet discovery)
 * + EIP-1193 over `personal_sign`, so Rabby, MetaMask, Valora, Coinbase, etc.
 * are all discoverable and pickable without a heavyweight connector library.
 *
 * Exposes connect/disconnect, the connected address + chainId, a `signMessage`
 * helper (used by the EVM claim banner), and the live EIP-1193 provider for
 * on-chain writes (the future give-feedback path). Server-safe: every browser
 * API touch is window-guarded, and the context degrades to a no-op set of
 * defaults during SSR.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface Eip1193Provider {
  request<T = unknown>(args: { method: string; params?: unknown[] | object }): Promise<T>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** EIP-6963 provider detail — one discovered injected wallet. */
export interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

interface Eip6963AnnounceEvent extends Event {
  detail: Eip6963ProviderDetail;
}

interface EvmWalletContextValue {
  address: `0x${string}` | null;
  chainId: number | null;
  connecting: boolean;
  /** Injected wallets discovered via EIP-6963, deduped by rdns. */
  wallets: Eip6963ProviderDetail[];
  /** Connect a specific discovered wallet (or the sole/last one). Returns the address or null. */
  connect: (detail?: Eip6963ProviderDetail) => Promise<`0x${string}` | null>;
  disconnect: () => void;
  /** personal_sign over a UTF-8 message. Returns the 0x… signature. Throws if not connected. */
  signMessage: (message: string) => Promise<string>;
  /** Best-effort chain switch (EIP-3326). Non-fatal — some in-app wallets don't support it. */
  switchChain: (chainIdHex: `0x${string}`) => Promise<void>;
  /** Live EIP-1193 provider of the connected wallet (or null) — for on-chain writes. */
  getProvider: () => Eip1193Provider | null;
}

const noop = async () => {
  throw new Error('EVM wallet not ready');
};

const EvmWalletContext = createContext<EvmWalletContextValue>({
  address: null,
  chainId: null,
  connecting: false,
  wallets: [],
  connect: noop,
  disconnect: () => {},
  signMessage: noop,
  switchChain: noop,
  getProvider: () => null,
});

const LAST_WALLET_KEY = 'ak:evm:last-rdns';

function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

/** Hex-encode a UTF-8 string for personal_sign — zero-dep, browser-safe. */
function utf8ToHex(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as `0x${string}`;
}

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Eip6963ProviderDetail[]>([]);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const providerRef = useRef<Eip1193Provider | null>(null);

  // EIP-6963 discovery: collect announced providers, deduped by rdns.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function onAnnounce(event: Event) {
      const { detail } = event as Eip6963AnnounceEvent;
      setWallets((prev) =>
        prev.some((w) => w.info.rdns === detail.info.rdns) ? prev : [...prev, detail],
      );
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);

  // Bind account/chain listeners to whichever provider is active.
  const bindEvents = useCallback((p: Eip1193Provider) => {
    if (!p.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      const next = accounts?.[0];
      if (isHexAddress(next)) setAddress(next);
      else {
        setAddress(null);
        providerRef.current = null;
      }
    };
    const onChain = (...args: unknown[]) => {
      const cid = args[0] as string | undefined;
      if (typeof cid === 'string') setChainId(Number.parseInt(cid, 16));
    };
    p.on('accountsChanged', onAccounts);
    p.on('chainChanged', onChain);
  }, []);

  const activate = useCallback(
    async (detail: Eip6963ProviderDetail, opts: { prompt: boolean }) => {
      const p = detail.provider;
      const accounts = await p.request<string[]>({
        method: opts.prompt ? 'eth_requestAccounts' : 'eth_accounts',
      });
      const addr = accounts?.[0];
      if (!isHexAddress(addr)) return null;
      providerRef.current = p;
      setAddress(addr);
      bindEvents(p);
      try {
        const cid = await p.request<string>({ method: 'eth_chainId' });
        if (typeof cid === 'string') setChainId(Number.parseInt(cid, 16));
      } catch {
        /* chainId is best-effort */
      }
      window.localStorage.setItem(LAST_WALLET_KEY, detail.info.rdns);
      return addr;
    },
    [bindEvents],
  );

  // Silent reconnect: if the last-used wallet still authorizes us, restore the
  // session without prompting. Runs once wallets are discovered.
  useEffect(() => {
    if (typeof window === 'undefined' || address || wallets.length === 0) return;
    const lastRdns = window.localStorage.getItem(LAST_WALLET_KEY);
    if (!lastRdns) return;
    const match = wallets.find((w) => w.info.rdns === lastRdns);
    if (!match) return;
    activate(match, { prompt: false }).catch(() => {
      /* not authorized anymore — stay disconnected */
    });
  }, [wallets, address, activate]);

  const connect = useCallback(
    async (detail?: Eip6963ProviderDetail): Promise<`0x${string}` | null> => {
      const target =
        detail ??
        (wallets.length === 1 ? wallets[0] : undefined) ??
        // Last resort: a single injected provider without EIP-6963 support.
        (typeof window !== 'undefined' && window.ethereum
          ? ({
              info: { uuid: 'injected', name: 'Browser Wallet', icon: '', rdns: 'injected' },
              provider: window.ethereum as Eip1193Provider,
            } satisfies Eip6963ProviderDetail)
          : undefined);
      if (!target) return null; // caller (button) shows the picker when multiple
      setConnecting(true);
      try {
        return await activate(target, { prompt: true });
      } finally {
        setConnecting(false);
      }
    },
    [wallets, activate],
  );

  const disconnect = useCallback(() => {
    providerRef.current = null;
    setAddress(null);
    setChainId(null);
    if (typeof window !== 'undefined') window.localStorage.removeItem(LAST_WALLET_KEY);
  }, []);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      const p = providerRef.current;
      if (!p || !address) throw new Error('Connect an EVM wallet first');
      return p.request<string>({
        method: 'personal_sign',
        params: [utf8ToHex(message), address],
      });
    },
    [address],
  );

  const switchChain = useCallback(async (chainIdHex: `0x${string}`) => {
    const p = providerRef.current;
    if (!p) return;
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  }, []);

  const getProvider = useCallback(() => providerRef.current, []);

  const value = useMemo<EvmWalletContextValue>(
    () => ({
      address,
      chainId,
      connecting,
      wallets,
      connect,
      disconnect,
      signMessage,
      switchChain,
      getProvider,
    }),
    [address, chainId, connecting, wallets, connect, disconnect, signMessage, switchChain, getProvider],
  );

  return <EvmWalletContext.Provider value={value}>{children}</EvmWalletContext.Provider>;
}

export function useEvmWallet(): EvmWalletContextValue {
  return useContext(EvmWalletContext);
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}
