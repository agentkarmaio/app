import { promises as fs } from 'fs';
import path from 'path';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export const metadata = {
  title: 'Karma Protocol — Specification',
  description: 'Open specification for multi-tier reputation scoring of autonomous on-chain agents on Solana.',
};

export default async function ProtocolPage() {
  // Read the RFC markdown at build/request time
  const rfcPath = path.join(process.cwd(), 'docs', 'rfc', 'karma-protocol.md');
  let content: string;
  try {
    content = await fs.readFile(rfcPath, 'utf-8');
  } catch {
    content = 'RFC document not found.';
  }

  const { version, status, date } = extractRFCMetadata(content);
  const sections = parseRFC(content);

  return (
    <div className="space-y-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div>
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Karma Protocol
        </h1>
        <p className="mt-1.5 text-[15px] text-[#8a8f98] tracking-[-0.165px]">
          Open specification for multi-tier reputation scoring of autonomous on-chain agents on Solana.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <span className="inline-flex items-center rounded-md bg-[rgb(255_165_0/0.12)] px-2 py-0.5 text-[11px] font-[510] text-[#f5a623] border border-[rgb(255_165_0/0.2)]">
            {status} v{version}
          </span>
          <span className="text-[12px] text-[#62666d]">
            Last updated: {date}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-6 sm:p-8">
        <article className="prose-protocol space-y-6">
          {sections.map((section, i) => (
            <Section key={i} {...section} />
          ))}
        </article>
      </div>
    </div>
  );
}

// --- RFC Metadata Extractor ---

function extractRFCMetadata(md: string): { version: string; status: string; date: string } {
  const head = md.split('\n').slice(0, 40).join('\n');
  const version = head.match(/\*\*Version:\*\*\s*([^\s(]+)/)?.[1] ?? '0.0.0';
  const status = head.match(/\*\*Status:\*\*\s*(\w+)/)?.[1] ?? 'Draft';
  const rawDate = head.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1];
  const date = rawDate
    ? new Date(rawDate + 'T00:00:00Z').toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : 'unknown';
  return { version, status, date };
}

// --- Minimal RFC Markdown Parser ---

interface RFCSection {
  type: 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'separator';
  level?: number;
  text?: string;
  lang?: string;
  rows?: string[][];
}

function parseRFC(md: string): RFCSection[] {
  const lines = md.split('\n');
  const sections: RFCSection[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip frontmatter-style lines
    if (line.startsWith('---')) {
      sections.push({ type: 'separator' });
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      sections.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    // Code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      sections.push({ type: 'code', text: codeLines.join('\n'), lang });
      i++;
      continue;
    }

    // Tables
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        const cells = lines[i].split('|').filter(Boolean).map((c) => c.trim());
        // Skip separator rows
        if (!cells.every((c) => /^[-:]+$/.test(c))) {
          tableRows.push(cells);
        }
        i++;
      }
      sections.push({ type: 'table', rows: tableRows });
      continue;
    }

    // Lists
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].match(/^[-*]\s/) || lines[i].match(/^\d+\.\s/))) {
        items.push(lines[i].replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
        i++;
      }
      sections.push({ type: 'list', text: items.join('\n') });
      continue;
    }

    // Paragraph
    if (line.trim()) {
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !lines[i].startsWith('|') && !lines[i].startsWith('---')) {
        paraLines.push(lines[i]);
        i++;
      }
      sections.push({ type: 'paragraph', text: paraLines.join(' ') });
      continue;
    }

    i++;
  }

  return sections;
}

function Section({ type, level, text, lang, rows }: RFCSection) {
  if (type === 'separator') {
    return <hr className="border-[rgb(255_255_255/0.06)]" />;
  }

  if (type === 'heading') {
    const Tag = `h${Math.min(level ?? 2, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
    const sizes: Record<number, string> = {
      1: 'text-[24px] font-[590] tracking-[-0.288px]',
      2: 'text-[20px] font-[590] tracking-[-0.24px]',
      3: 'text-[16px] font-[590] tracking-[-0.176px]',
      4: 'text-[14px] font-[590] tracking-[-0.154px]',
    };
    return <Tag className={`${sizes[level ?? 2]} text-[#f7f8f8] mt-4`}>{text}</Tag>;
  }

  if (type === 'code') {
    return (
      <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(0_0_0/0.3)] overflow-x-auto">
        {lang && (
          <div className="border-b border-[rgb(255_255_255/0.06)] px-3 py-1">
            <span className="text-[11px] text-[#62666d] font-mono">{lang}</span>
          </div>
        )}
        <pre className="p-3 text-[13px] leading-relaxed font-mono text-[#d0d6e0] whitespace-pre overflow-x-auto">
          {text}
        </pre>
      </div>
    );
  }

  if (type === 'table' && rows) {
    return (
      <div className="overflow-x-auto rounded-md border border-[rgb(255_255_255/0.06)]">
        <table className="w-full text-[13px]">
          {rows[0] && (
            <thead>
              <tr className="border-b border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)]">
                {rows[0].map((cell, j) => (
                  <th key={j} className="px-3 py-2 text-left font-[510] text-[#8a8f98]">{cell}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.slice(1).map((row, i) => (
              <tr key={i} className="border-b border-[rgb(255_255_255/0.04)]">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-2 text-[#d0d6e0]">
                    <InlineCode text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (type === 'list') {
    const items = (text ?? '').split('\n');
    return (
      <ul className="list-disc pl-5 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-[14px] text-[#b4bcd0] leading-relaxed">
            <InlineCode text={item} />
          </li>
        ))}
      </ul>
    );
  }

  // paragraph
  return (
    <p className="text-[14px] text-[#b4bcd0] leading-relaxed">
      <InlineCode text={text ?? ''} />
    </p>
  );
}

function InlineCode({ text }: { text: string }) {
  // Handle inline code and bold
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="rounded bg-[rgb(255_255_255/0.06)] px-1 py-0.5 text-[12px] font-mono text-[#d0d6e0]">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="font-[590] text-[#f7f8f8]">{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
