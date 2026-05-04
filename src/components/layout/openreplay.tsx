"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

type TrackerInstance = {
  start: () => void;
  use: (plugin: unknown) => void;
  setUserID: (id: string) => void;
};

export function OpenReplay() {
  const trackerRef = useRef<TrackerInstance | null>(null);
  const { publicKey } = useWallet();

  useEffect(() => {
    if (window.location.protocol !== "https:") return;
    let cancelled = false;
    (async () => {
      const [{ default: Tracker }, { default: trackerAssist }] = await Promise.all([
        import("@openreplay/tracker"),
        import("@openreplay/tracker-assist"),
      ]);
      if (cancelled) return;
      const tracker = new Tracker({
        projectKey: "kFAjfUrPUfjAJEoutGuT",
        ingestPoint: `${window.location.origin}/_or/ingest`,
      }) as unknown as TrackerInstance;
      tracker.use(trackerAssist({}));
      tracker.start();
      trackerRef.current = tracker;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    tracker.setUserID(publicKey ? publicKey.toBase58() : "");
  }, [publicKey]);

  return null;
}
