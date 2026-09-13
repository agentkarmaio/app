import { describe, expect, test } from 'bun:test';
import { makeIndexingFetch } from './indexing-fetch';
import { runWithIndexingContext } from './indexing-context';

const endpoint = (name: string) => `https://db.invalid/rest/v1/rpc/${name}`;
/** A stalled transport which honors fetch cancellation, with a test-only guard. */
function stalledTransport(
  signals: Array<AbortSignal | null | undefined>,
): typeof fetch {
  return ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    signals.push(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      const stop = () => {
        clearTimeout(guard);
        reject(init?.signal?.reason);
      };
      const guard = setTimeout(() => {
        init?.signal?.removeEventListener('abort', stop);
        reject(Error('test_transport_failsafe'));
      }, 150);
      if (init?.signal?.aborted) stop();
      else init?.signal?.addEventListener('abort', stop, { once: true });
    });
  }) as typeof fetch;
}

describe('lease control RPC deadlines', () => {
  for (const name of [
    'acquire_indexing_lease',
    'renew_indexing_lease',
    'finish_indexing_run',
  ]) {
    test(`${name} aborts a stalled transport outside any ingestion context`, async () => {
      const signals: Array<AbortSignal | null | undefined> = [];
      const wrapped = makeIndexingFetch(stalledTransport(signals), {
        controlTimeoutMs: 10,
      });
      await expect(wrapped(endpoint(name))).rejects.toThrow(
        'indexing_control_timeout',
      );
      expect(signals[0]?.aborted).toBe(true);
    });
  }

  test('deadline also covers a response body stalled after successful headers', async () => {
    const transport = ((
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              const guard = setTimeout(
                () => controller.error(Error('test_body_failsafe')),
                150,
              );
              init?.signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(guard);
                  controller.error(init.signal?.reason);
                },
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const wrapped = makeIndexingFetch(transport, { controlTimeoutMs: 10 });
    await expect(wrapped(endpoint('finish_indexing_run'))).rejects.toThrow(
      'indexing_control_timeout',
    );
  });

  test('caller cancellation is composed with the deadline for Request and init signals', async () => {
    for (const useRequest of [true, false]) {
      const signals: Array<AbortSignal | null | undefined> = [];
      const controller = new AbortController();
      const wrapped = makeIndexingFetch(stalledTransport(signals), {
        controlTimeoutMs: 100,
      });
      const input = useRequest
        ? new Request(endpoint('acquire_indexing_lease'), {
            signal: controller.signal,
          })
        : endpoint('acquire_indexing_lease');
      const pending = wrapped(
        input,
        useRequest ? undefined : { signal: controller.signal },
      );
      controller.abort(Error('caller_cancelled'));
      await expect(pending).rejects.toThrow('caller_cancelled');
      expect(signals[0]?.aborted).toBe(true);
    }
  });

  test('successful control responses preserve payload, auth and active lease headers', async () => {
    let received: RequestInit | undefined;
    const transport = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      received = init;
      return new Response('[{"generation":1}]', {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-result': 'kept' },
      });
    }) as typeof fetch;
    const wrapped = makeIndexingFetch(transport, { controlTimeoutMs: 10 });
    const response = await runWithIndexingContext(
      { chain: 'arc', path: 'transfers', owner: 'current-owner' },
      () =>
        wrapped(
          new Request(endpoint('renew_indexing_lease'), {
            method: 'POST',
            headers: {
              authorization: 'Bearer test-only',
              'x-indexing-owner': 'spoofed',
              'content-type': 'application/json',
            },
            body: '{}',
          }),
          { headers: { 'x-client-info': 'retained' } },
        ),
    );
    const headers = new Headers(received?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-only');
    expect(headers.get('x-client-info')).toBe('retained');
    expect(headers.get('x-indexing-owner')).toBe('current-owner');
    expect(headers.get('x-indexing-chain')).toBe('arc');
    expect(response.status).toBe(201);
    expect(response.headers.get('x-result')).toBe('kept');
    expect(await response.json()).toEqual([{ generation: 1 }]);
    await Bun.sleep(15);
    expect(received?.signal?.aborted).toBe(false);
  });

  test('ordinary Supabase requests keep caller transport and have no new deadline', async () => {
    const caller = new AbortController();
    let received: RequestInit | undefined;
    const original = new Response('ordinary');
    const transport = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      received = init;
      await Bun.sleep(20);
      return original;
    }) as typeof fetch;
    const wrapped = makeIndexingFetch(transport, { controlTimeoutMs: 5 });
    const response = await wrapped(
      'https://db.invalid/rest/v1/wallets?name=acquire_indexing_lease',
      { signal: caller.signal, headers: { 'x-indexing-owner': 'spoofed' } },
    );
    expect(response).toBe(original);
    expect(received?.signal).toBe(caller.signal);
    expect(new Headers(received?.headers).has('x-indexing-owner')).toBe(false);
  });

  test('an already cancelled indexing context never reaches the transport', () => {
    let calls = 0;
    const transport = (async (_input: Parameters<typeof fetch>[0]) => {
      calls++;
      return new Response('unused');
    }) as typeof fetch;
    const wrapped = makeIndexingFetch(transport, { controlTimeoutMs: 10 });
    const controller = new AbortController();
    controller.abort();
    runWithIndexingContext(
      {
        chain: 'arc',
        path: 'transfers',
        owner: 'old-owner',
        signal: controller.signal,
      },
      () => {
        expect(() => wrapped(endpoint('renew_indexing_lease'))).toThrow(
          'indexing_lease_lost',
        );
      },
    );
    expect(calls).toBe(0);
  });
});
