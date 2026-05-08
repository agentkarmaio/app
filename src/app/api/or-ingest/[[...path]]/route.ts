import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/rate-limit";

const UPSTREAM = "https://replay.noras.systems/ingest";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const handle = async (
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> => {
  const { path = [] } = await ctx.params;
  const search = new URL(req.url).search;
  const target = `${UPSTREAM}${path.length ? "/" + path.join("/") : ""}${search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  // OpenReplay geolocates from the leftmost X-Forwarded-For. Behind Cloudflare
  // + Traefik the original client IP can get buried; pin it explicitly so
  // sessions show the visitor's location, not the Servel host.
  const clientIp = getClientIp(req);
  if (clientIp && clientIp !== "unknown") {
    headers.set("x-forwarded-for", clientIp);
    headers.set("x-real-ip", clientIp);
  }
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) headers.set("x-forwarded-for", cfIp);

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    // @ts-expect-error duplex is required when streaming a request body
    duplex: hasBody ? "half" : undefined,
  });

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const PATCH = handle;
