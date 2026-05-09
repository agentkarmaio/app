"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { registerOpenReplayTracker } from "@/lib/openreplay";

type TrackerInstance = {
  start: () => void;
  use: (plugin: unknown) => void;
  setUserID: (id: string) => void;
  setMetadata?: (key: string, value: string) => void;
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
        ingestPoint: "https://replay.noras.systems/ingest",
      }) as unknown as TrackerInstance;
      tracker.use(trackerAssist({}));
      tracker.start();
      trackerRef.current = tracker;
      registerOpenReplayTracker(tracker);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker || !publicKey) return;
    tracker.setUserID(publicKey.toBase58());
  }, [publicKey]);

  return null;
}
