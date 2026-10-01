// Run with an existing Playwright page; its origin selects the target environment.
// Uses an isolated Brave browser and live API responses without fixtures.
export default async function checkExplorerNavigation(page) {
  const browser = await page.context().browser().browserType().launch({
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
  try {
    const p = await browser.newPage();
    const base = page.url().startsWith('http') ? new URL(page.url()).origin : 'https://agentkarma.io';
    await p.goto(`${base}/explore`);
    await p.waitForSelector('tbody a');
    const navigations = [];
    p.on('request', (r) => {
      const url = new URL(r.url());
      if (url.pathname === '/explore' && url.searchParams.has('_rsc')) navigations.push(r.url());
    });
    const checks = [];
    for (const [label, chain] of [['Solana', 'solana'], ['Celo', 'celo'], ['Arc', 'arc-mainnet'], ['Stellar', null]]) {
      const response = p.waitForResponse((r) => {
        const url = new URL(r.url());
        return url.pathname === '/api/explore/agents' && url.searchParams.get('chain') === (chain ?? 'stellar');
      });
      const started = Date.now();
      await p.getByRole('button', { name: label, exact: true }).click();
      await p.waitForFunction((name) => [...document.querySelectorAll('button')].some((b) => b.textContent === name && b.className.includes('bg-')), label);
      const selectedMs = Date.now() - started;
      const result = await response;
      if (!result.ok()) throw new Error(`${label}: HTTP ${result.status()}`);
      const data = await result.json();
      if (!data.wallets.length || data.wallets.some((w) => w.chain !== (chain ?? 'stellar'))) throw new Error(`${label}: incorrect chain data`);
      await p.waitForFunction((addresses) => {
        const links = [...document.querySelectorAll('tbody a')];
        return links.length === addresses.length && links.every((link, i) =>
          new URL(link.href).pathname === `/agent/${addresses[i]}`);
      }, data.wallets.map((wallet) => wallet.address));
      if (new URL(p.url()).searchParams.get('chain') !== chain) throw new Error(`${label}: URL did not update`);
      checks.push({ label, selectedMs, total: data.total });
    }
    if (navigations.length) throw new Error(`Chain switching made ${navigations.length} unnecessary server navigations: ${JSON.stringify(checks)}`);
    return { checks, serverNavigations: navigations.length };
  } finally {
    await browser.close();
  }
}
