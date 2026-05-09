import type { Metadata } from "next";
import { cookies } from "next/headers";
import { unstable_cache } from "next/cache";
import { DeckGate } from "@/components/deck/deck-gate";
import { getDeckViewCount } from "@/db/client";
import { DECK_COOKIE_NAME, verifyDeckCookie } from "@/lib/deck-cookie";

export const metadata: Metadata = {
  title: "Pitch deck",
  description:
    "AgentKarma pitch deck — reputation layer for autonomous on-chain agents on Solana.",
  alternates: { canonical: "/deck" },
  robots: { index: false, follow: true },
};

const cachedViewCount = unstable_cache(
  async () => {
    try {
      return await getDeckViewCount();
    } catch {
      return 0;
    }
  },
  ["deck-view-count"],
  { revalidate: 60 },
);

export default async function DeckPage() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(DECK_COOKIE_NAME)?.value;
  const verified = verifyDeckCookie(cookieValue);
  const viewCount = await cachedViewCount();

  return (
    <DeckGate
      viewCount={viewCount}
      initialAuthed={Boolean(verified)}
      initialEmail={verified?.email ?? null}
    />
  );
}
