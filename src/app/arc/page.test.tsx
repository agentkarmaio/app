import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ArcPage from './page';
import { NotIndexedBlock } from '@/components/karma/not-indexed-block';
import { ChainFilterPill } from '@/components/karma/chain-filter-pill';
import { AK_ARC } from '@/config/ak-validator';

test('testnet archive preserves the original identity and points to mainnet coverage', () => {
  const html = renderToStaticMarkup(<ArcPage />);
  expect(html).toContain('Arc testnet is retired');
  expect(html).toContain('read-only');
  expect(html).toContain('href="/arc/mainnet"');
  expect(html).toContain(`/agent/${AK_ARC.controller}?chain=arc&amp;agentId=${AK_ARC.agentId}`);
});

test('unknown testnet profiles do not promise indexing or new claims', () => {
  const html = renderToStaticMarkup(<NotIndexedBlock chain="arc" />);
  expect(html).toContain('Arc testnet is retired');
  expect(html).toContain('No archived testnet profile');
  expect(html).not.toContain('next index pass');
});

test('active filters offer mainnet without promoting retired testnet', () => {
  const html = renderToStaticMarkup(<ChainFilterPill value="All" onChange={() => {}} />);
  expect(html).toContain('Arc mainnet');
  expect(html).not.toContain('Arc testnet');
});
