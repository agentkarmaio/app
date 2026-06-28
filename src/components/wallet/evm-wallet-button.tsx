'use client';

/**
 * EvmWalletButton — the Celo / Arc counterpart of WalletConnectButton. Same
 * pill styling and connected-state dropdown as the Solana button; the only
 * extra is an EIP-6963 wallet picker when more than one injected wallet is
 * present (Rabby + MetaMask side by side, the exact case Celina's operator hit).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Wallet as WalletIcon, Copy, LogOut, ChevronDown } from 'lucide-react';
import { useEvmWallet, type Eip6963ProviderDetail } from '@/components/wallet/evm-wallet-provider';

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function EvmWalletButton() {
  const { address, connecting, wallets, connect, disconnect } = useEvmWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const onConnect = useCallback(() => {
    // 0 or 1 wallet → connect directly (provider falls back to window.ethereum);
    // multiple → let the user pick which injected wallet to use.
    if (wallets.length > 1) setPickerOpen(true);
    else void connect();
  }, [wallets.length, connect]);

  const pick = useCallback(
    (detail: Eip6963ProviderDetail) => {
      setPickerOpen(false);
      void connect(detail);
    },
    [connect],
  );

  const copy = useCallback(async () => {
    if (address) {
      await navigator.clipboard.writeText(address);
      setMenuOpen(false);
    }
  }, [address]);

  const doDisconnect = useCallback(() => {
    setMenuOpen(false);
    disconnect();
  }, [disconnect]);

  useEffect(() => {
    if (!menuOpen && !pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen, pickerOpen]);

  if (!address) {
    return (
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="flex items-center gap-1.5 rounded-full border border-[rgb(255_255_255/0.1)] bg-[rgb(255_255_255/0.03)] px-3 py-1 text-[12px] font-[510] text-[#d0d6e0] transition-colors hover:border-[rgb(255_255_255/0.16)] hover:bg-[rgb(255_255_255/0.05)] hover:text-[#f7f8f8] disabled:opacity-60"
        >
          <WalletIcon className="size-3.5" />
          {connecting ? 'Connecting…' : 'Connect'}
        </button>

        {pickerOpen && wallets.length > 0 && (
          <div className="absolute right-0 mt-1.5 w-52 rounded-xl border border-[rgb(255_255_255/0.08)] bg-[#0f1011] shadow-lg overflow-hidden z-50">
            {wallets.map((w) => (
              <button
                key={w.info.rdns}
                type="button"
                onClick={() => pick(w)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[#d0d6e0] transition-colors hover:bg-[rgb(255_255_255/0.04)]"
              >
                {w.info.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element -- wallet-supplied data: URI icon
                  <img src={w.info.icon} alt="" aria-hidden className="size-4 shrink-0 rounded" />
                ) : (
                  <WalletIcon className="size-4 shrink-0" />
                )}
                {w.info.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-[rgb(94_106_210/0.25)] bg-[rgb(94_106_210/0.10)] px-3 py-1 font-mono text-[12px] font-[510] text-[#828fff] transition-colors hover:bg-[rgb(94_106_210/0.16)]"
      >
        <span className="size-1.5 rounded-full bg-[#7170ff]" />
        {truncate(address)}
        <ChevronDown className="size-3" />
      </button>

      {menuOpen && (
        <div className="absolute right-0 mt-1.5 w-44 rounded-xl border border-[rgb(255_255_255/0.08)] bg-[#0f1011] shadow-lg overflow-hidden z-50">
          <button
            type="button"
            onClick={copy}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[#d0d6e0] transition-colors hover:bg-[rgb(255_255_255/0.04)]"
          >
            <Copy className="size-3.5" />
            Copy address
          </button>
          <button
            type="button"
            onClick={doDisconnect}
            className="flex w-full items-center gap-2 border-t border-[rgb(255_255_255/0.05)] px-3 py-2 text-left text-[12px] text-[#e5484d] transition-colors hover:bg-[rgb(229_72_77/0.08)]"
          >
            <LogOut className="size-3.5" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
