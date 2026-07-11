/// <reference types="bun-types" />
/**
 * MetadataBreakdown — the shared "Why did this agent get this score" panel.
 * Static markup assertions (no DOM): it renders every rubric dimension with its
 * earned/max points, surfaces the AK current-assessment header + score, labels a
 * version divergence honestly (on-chain vX vs current assessment), collapses to a
 * plain scheme label when versions match, and lists the scorer notes.
 *
 * Run: bun test src/components/karma/metadata-breakdown.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetadataBreakdown } from './metadata-breakdown';
import { METADATA_RUBRIC } from '@/scoring/celo-metadata';
import type { MetadataQualityResult } from '@/scoring/celo-metadata';

function result(over: Partial<MetadataQualityResult> = {}): MetadataQualityResult {
  return {
    score: 73,
    breakdown: {
      resolves: 15,
      typeCorrect: 10,
      name: 8,
      descriptionSubstance: 6,
      image: 7,
      imageUrlValid: 3,
      services: 8,
      serviceRichness: 0,
      endpointUrlValid: 6,
      activeAndTrust: 0,
      tamperResistance: 0,
      crossChain: 5,
    },
    notes: ['registration JSON resolves', 'name declared'],
    ...over,
  };
}

describe('MetadataBreakdown', () => {
  test('renders the AK assessment header with the computed score', () => {
    const html = renderToStaticMarkup(
      <MetadataBreakdown result={result()} schemeVersion="v0.2" onChainVersion="v0.2" />,
    );
    expect(html).toContain('AK current assessment');
    expect(html).toContain('score 73/100');
  });

  test('matching versions show a plain scheme label, no divergence copy', () => {
    const html = renderToStaticMarkup(
      <MetadataBreakdown result={result()} schemeVersion="v0.2" onChainVersion="v0.2" />,
    );
    expect(html).toContain('scheme v0.2');
    expect(html).not.toContain('on-chain:');
  });

  test('a version divergence is labelled honestly (on-chain vs current)', () => {
    const html = renderToStaticMarkup(
      <MetadataBreakdown result={result()} schemeVersion="v0.2" onChainVersion="v0.1" />,
    );
    expect(html).toContain('on-chain: v0.1 · current assessment: v0.2');
  });

  test('missing on-chain version falls back to v? in the divergence label', () => {
    const html = renderToStaticMarkup(
      <MetadataBreakdown result={result()} schemeVersion="v0.2" onChainVersion="" />,
    );
    expect(html).toContain('on-chain: v? · current assessment: v0.2');
  });

  test('renders every rubric dimension with its earned/max points', () => {
    const html = renderToStaticMarkup(
      <MetadataBreakdown result={result()} schemeVersion="v0.2" onChainVersion="v0.2" />,
    );
    for (const dim of METADATA_RUBRIC) {
      expect(html).toContain(dim.label);
    }
    // earned/max pairs for representative full, partial, and zero dimensions.
    expect(html).toContain('15/15'); // resolves (full)
    expect(html).toContain('6/12'); // descriptionSubstance (partial)
    expect(html).toContain('0/8'); // serviceRichness (zero)
  });

  test('lists the scorer notes', () => {
    const html = renderToStaticMarkup(
      <MetadataBreakdown result={result()} schemeVersion="v0.2" onChainVersion="v0.2" />,
    );
    expect(html).toContain('Notes');
    expect(html).toContain('registration JSON resolves');
    expect(html).toContain('name declared');
  });
});
