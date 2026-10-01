import { expect, test } from 'bun:test';
import { StellarAgentProfile } from './stellar-agent-profile';
import type { Wallet } from '@/db/schema';
import { renderToStaticMarkup } from 'react-dom/server';

test('a Stellar registered agent exposes the on-chain feedback form in the profile shell', () => {
  const address = 'GA6OBKNSBCY2I4PQLGNNQQXRXWXRUBRLSKLM7YP7QBBSRW7LCZFLHODV';
  const html = renderToStaticMarkup(
    <StellarAgentProfile
      wallet={address}
      agentId={66}
      walletRow={{ address, chain: 'stellar', stellar_agent_id: 66, claimed: false } as Wallet}
    />,
  );
  expect(html).toContain('Leave on-chain feedback');
  expect(html).toContain('5 stars');
  expect(html).toContain('Comment');
});
