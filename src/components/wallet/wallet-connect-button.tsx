'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Wallet as WalletIcon, Copy, LogOut, ChevronDown } from 'lucide-react';

function truncate(pk: string) {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export function WalletConnectButton() {
  const { publicKey, connected, connecting, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const onConnect = useCallback(() => setVisible(true), [setVisible]);

  const copy = useCallback(async () => {
    if (publicKey) {
      await navigator.clipboard.writeText(publicKey.toBase58());
      setOpen(false);
    }
  }, [publicKey]);

  const doDisconnect = useCallback(async () => {
    setOpen(false);
    await disconnect();
  }, [disconnect]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!connected || !publicKey) {
    return (
      <button
        type="button"
        onClick={onConnect}
        disabled={connecting}
        className="flex items-center gap-1.5 rounded-full border border-[rgb(255_255_255/0.1)] bg-[rgb(255_255_255/0.03)] px-3 py-1 text-[12px] font-[510] text-[#d0d6e0] transition-colors hover:border-[rgb(255_255_255/0.16)] hover:bg-[rgb(255_255_255/0.05)] hover:text-[#f7f8f8] disabled:opacity-60"
      >
        <WalletIcon className="size-3.5" />
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-[rgb(94_106_210/0.25)] bg-[rgb(94_106_210/0.10)] px-3 py-1 font-mono text-[12px] font-[510] text-[#828fff] transition-colors hover:bg-[rgb(94_106_210/0.16)]"
      >
        <span className="size-1.5 rounded-full bg-[#7170ff]" />
        {truncate(publicKey.toBase58())}
        <ChevronDown className="size-3" />
      </button>

      {open && (
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
