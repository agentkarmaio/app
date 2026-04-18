'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CodeBlock({ lang, children }: { lang: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(0_0_0/0.3)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[rgb(255_255_255/0.06)] px-3 py-1">
        <span className="text-[11px] text-[#62666d] font-mono">{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy to clipboard'}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-[510] text-[#8a8f98] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.06)] transition-colors"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-3 text-[12px] leading-relaxed font-mono text-[#d0d6e0] whitespace-pre overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}
