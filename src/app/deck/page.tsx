import type { Metadata } from "next";
import { cookies } from "next/headers";
import { unstable_cache } from "next/cache";
import { DeckGate } from "@/components/deck/deck-gate";
import { getDeckUniqueViewerCount } from "@/db/client";
import { DECK_COOKIE_NAME, verifyDeckCookie } from "@/lib/deck-cookie";

export const metadata: Metadata = {
  title: "Pitch deck",
  description:
    "AgentKarma pitch deck — reputation layer for autonomous on-chain agents on Solana.",
  alternates: { canonical: "/deck" },
  robots: { index: false, follow: true },
};

// Cache the viewer count separately from the page so the per-request DB hit
// doesn't fire on every navigation. Page itself is dynamic (cookie-aware).
const cachedViewerCount = unstable_cache(
  async () => {
    try {
      return await getDeckUniqueViewerCount();
    } catch {
      return 0;
    }
  },
  ["deck-viewer-count"],
  { revalidate: 60 },
);

export default async function DeckPage() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(DECK_COOKIE_NAME)?.value;
  const verified = verifyDeckCookie(cookieValue);
  const viewerCount = await cachedViewerCount();

  return (
    <DeckGate
      viewerCount={viewerCount}
      initialAuthed={Boolean(verified)}
      initialEmail={verified?.email ?? null}
    />
  );
}
