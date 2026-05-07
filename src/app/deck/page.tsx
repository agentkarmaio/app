import type { Metadata } from "next";
import { DeckGate } from "@/components/deck/deck-gate";
import { getDeckUniqueViewerCount } from "@/db/client";

export const metadata: Metadata = {
  title: "Pitch deck",
  description:
    "AgentKarma pitch deck — reputation layer for autonomous on-chain agents on Solana.",
  alternates: { canonical: "/deck" },
  robots: { index: false, follow: true },
};

// ISR — viewer count refreshes once a minute. Page itself is otherwise static.
export const revalidate = 60;

export default async function DeckPage() {
  let viewerCount = 0;
  try {
    viewerCount = await getDeckUniqueViewerCount();
  } catch {
    // DB hiccup shouldn't block the gate. Fall through to 0 (which we hide).
  }
  return <DeckGate viewerCount={viewerCount} />;
}
