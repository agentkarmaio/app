import { expect, test } from 'bun:test';
import { createArcRpcGate } from './arc-rpc-gate';
import { ARC_LOG_BUDGET_EXHAUSTED } from './arc-log-range';

test('admission spaces concurrent timestamp requests and every later retry', async () => {
  let time = 0;
  const starts: number[] = [];
  const rpc = createArcRpcGate({ deadline: 5000, now: () => time, sleep: async ms => { time += ms; } });
  await Promise.all([rpc(async () => { starts.push(time); }), rpc(async () => { starts.push(time); })]);
  await rpc(async () => { starts.push(time); });
  expect(starts).toEqual([0, 250, 500]);
});

test('a throttle sets shared cooldown before the next admitted call', async () => {
  let time = 0;
  const rpc = createArcRpcGate({ deadline: 5000, now: () => time, sleep: async ms => { time += ms; } });
  await expect(rpc(async () => { throw Error('429'); })).rejects.toThrow('429');
  let started = -1;
  await rpc(async () => { started = time; });
  expect(started).toBeGreaterThanOrEqual(800);
});

test('pacing never launches a request after the scan budget expires', async () => {
  let time = 0, calls = 0;
  const rpc = createArcRpcGate({ deadline: 200, now: () => time, sleep: async ms => { time += ms; } });
  await rpc(async () => { calls++; });
  await expect(rpc(async () => { calls++; })).rejects.toBe(ARC_LOG_BUDGET_EXHAUSTED);
  expect(calls).toBe(1);
});

test('cancellation while queued suppresses the provider call', async () => {
  let time = 0, calls = 0;
  const controller = new AbortController();
  const rpc = createArcRpcGate({ signal: controller.signal, deadline: 5000, now: () => time,
    sleep: async ms => { time += ms; controller.abort(Error('cancelled')); } });
  await rpc(async () => { calls++; });
  await expect(rpc(async () => { calls++; })).rejects.toThrow('cancelled');
  expect(calls).toBe(1);
});

test('scheduled viem transport does not multiply the explicit retry budget', async () => {
  const { createArcTransfersClient } = await import('./arc-transfers');
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } });
  } });
  try {
    await expect(createArcTransfersClient(`http://127.0.0.1:${server.port}`).getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(requests).toBe(1);
  } finally { await server.stop(true); }
});

test('a pending admission rechecks a cooldown extended while it was asleep', async () => {
  let time = 0;
  const waits: Array<{ ms: number; resume: () => void }> = [];
  const rpc = createArcRpcGate({ deadline: 5000, now: () => time,
    sleep: ms => new Promise<void>(resume => { waits.push({ ms, resume }); }) });
  let rejectFirst!: (error: Error) => void;
  const first = rpc(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; })).catch(error => error);
  const secondStarted: number[] = [];
  const second = rpc(async () => { secondStarted.push(time); });
  while (!waits.length) await Bun.sleep(1);
  time = 100;
  rejectFirst(Error('429'));
  await first;
  time = 250;
  waits[0].resume();
  while (waits.length < 2) await Bun.sleep(1);
  expect(secondStarted).toEqual([]);
  expect(waits[1].ms).toBe(650);
  time = 900;
  waits[1].resume();
  await second;
  expect(secondStarted).toEqual([900]);
});
