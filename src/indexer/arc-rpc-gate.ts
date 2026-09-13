import { sleep as delay } from '@/lib/retry';
import { isRateLimitedError } from '@/lib/rpc-retry';
import { ARC_LOG_BUDGET_EXHAUSTED } from './arc-log-range';

/** One scheduled scan's RPC admission budget. Retry attempts pass through the
 * same gate; interactive profile clients are unaffected. */
export function createArcRpcGate(opts: {
  signal?: AbortSignal;
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? delay;
  let nextStart = 0;
  let cooldownUntil = 0;
  let admission: Promise<void> = Promise.resolve();
  const check = () => {
    opts.signal?.throwIfAborted();
    if (now() >= opts.deadline) throw ARC_LOG_BUDGET_EXHAUSTED;
  };
  return async function read<T>(request: () => Promise<T>): Promise<T> {
    const ticket = admission.then(async () => {
      check();
      // A request can finish with a throttle while another admission is asleep.
      // Re-evaluate the shared cooldown before releasing that waiting caller.
      for (;;) {
        const start = Math.max(nextStart, cooldownUntil);
        if (start >= opts.deadline) throw ARC_LOG_BUDGET_EXHAUSTED;
        const wait = start - now();
        if (wait <= 0) break;
        await sleep(wait);
        check();
      }
      nextStart = now() + 250;
    });
    admission = ticket.catch(() => {});
    await ticket;
    check();
    try {
      return await request();
    } catch (error) {
      if (isRateLimitedError(error)) cooldownUntil = Math.max(cooldownUntil, now() + 800);
      throw error;
    }
  };
}
