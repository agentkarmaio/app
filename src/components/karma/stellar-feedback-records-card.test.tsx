import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StellarFeedbackRecordsCard } from './stellar-feedback-records-card';
import type { StellarFeedbackRecord } from '@/lib/stellar-feedback';

const review: StellarFeedbackRecord = {
  client: 'GA6OBKNSBCY2I4PQLGNNQQXRXWXRUBRLSKLM7YP7QBBSRW7LCZFLHODV',
  feedbackIndex: '1', rawValue: '80', value: 80, valueDecimals: 0,
  tag1: 'agentkarma_review', tag2: 'v0.1', revoked: false,
};

test('only a complete empty read claims no feedback', () => {
  const complete = renderToStaticMarkup(<StellarFeedbackRecordsCard records={[]} count={0} complete commentsComplete />);
  expect(complete).toContain('No on-chain feedback yet');
  const partial = renderToStaticMarkup(<StellarFeedbackRecordsCard records={[]} count={null} complete={false} commentsComplete={false} />);
  expect(partial).not.toContain('No on-chain feedback yet');
  expect(partial).toContain('incomplete coverage');
  expect(partial).toContain('Reload the page');
});

test('renders review stars, revocation and external comment provenance safely', () => {
  const html = renderToStaticMarkup(<StellarFeedbackRecordsCard
    records={[{ ...review, revoked: true, comment: '<script>bad()</script>', commentVerified: false }]}
    count={0} complete commentsComplete
  />);
  expect(html).toContain('4 / 5 stars');
  expect(html).toContain('Revoked');
  expect(html).toContain('Comment indexed by Stellar8004');
  expect(html).not.toContain('Comment verified');
  expect(html).not.toContain('<script>bad()');
  expect(html).toContain(review.client);
});

test('keeps other feedback scales separate from human star reviews', () => {
  const html = renderToStaticMarkup(<StellarFeedbackRecordsCard
    records={[{ ...review, tag1: 'latency', value: 500 }]}
    count={1} complete commentsComplete={false}
  />);
  expect(html).toContain('500 · latency');
  expect(html).not.toContain('/ 5 stars');
  expect(html).toContain('Some indexed comments may be unavailable');
});
