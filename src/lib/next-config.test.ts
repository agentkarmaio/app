import { expect, test } from 'bun:test';
import nextConfig from '../../next.config';

test('client router keeps dynamic pages for 60s, matching the server profile cache', () => {
  // Without this Next 16 refetches every dynamic route on revisit (default 0s),
  // which re-shows loading.tsx on each back-and-forth between profiles.
  expect(nextConfig.experimental?.staleTimes?.dynamic).toBe(60);
});
