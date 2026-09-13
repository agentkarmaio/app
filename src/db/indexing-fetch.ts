import { getIndexingHeaders } from './indexing-context';

/** Fetch stays process-global; ownership is evaluated for EACH request. */
export function makeIndexingFetch(
  transport: typeof fetch = fetch,
  options: { controlTimeoutMs?: number } = {},
): typeof fetch {
  const controlTimeoutMs = options.controlTimeoutMs ?? 20_000;
  if (!Number.isFinite(controlTimeoutMs) || controlTimeoutMs <= 0)
    throw Error('Invalid indexing control timeout');
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    for (const key of [
      'x-indexing-chain',
      'x-indexing-path',
      'x-indexing-owner',
    ])
      headers.delete(key);
    for (const [key, value] of Object.entries(getIndexingHeaders()))
      headers.set(key, value);
    const requestInit = { ...init, headers };
    const url = new URL(input instanceof Request ? input.url : String(input));
    const control =
      /\/rpc\/(acquire_indexing_lease|renew_indexing_lease|finish_indexing_run)\/?$/.test(
        url.pathname,
      );
    if (!control) return transport(input, requestInit);
    return controlRequest(input, requestInit);
  }) as typeof fetch;

  async function controlRequest(
    input: Parameters<typeof fetch>[0],
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const callerSignal =
      init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const timer = setTimeout(
      () => controller.abort(Error('indexing_control_timeout')),
      controlTimeoutMs,
    );
    try {
      signal.throwIfAborted();
      const response = await transport(input, { ...init, signal });
      // PostgREST lease responses are small. Keep the deadline until their
      // complete body arrives: fetch resolving headers alone is not completion.
      // Read a clone so the caller retains the original Response metadata/body.
      await response.clone().arrayBuffer();
      signal.throwIfAborted();
      return response;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
