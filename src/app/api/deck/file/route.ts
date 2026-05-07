import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DECK_COOKIE_NAME, verifyDeckCookie } from "@/lib/deck-cookie";

const PDF_PATH = path.join(process.cwd(), "private", "deck.pdf");

export async function GET(request: NextRequest) {
  const cookie = request.cookies.get(DECK_COOKIE_NAME)?.value;
  const verified = verifyDeckCookie(cookie);
  if (!verified) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let buf: Buffer;
  let mtime: Date;
  try {
    [buf, { mtime }] = await Promise.all([readFile(PDF_PATH), stat(PDF_PATH)]);
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(buf.byteLength),
      "Content-Disposition": 'inline; filename="agentkarma-deck.pdf"',
      "Cache-Control": "private, max-age=300",
      "Last-Modified": mtime.toUTCString(),
    },
  });
}
