type Tracker = {
  setUserID: (id: string) => void;
  setMetadata?: (key: string, value: string) => void;
};

let activeTracker: Tracker | null = null;
let pendingUserID: string | null = null;
const pendingMetadata: Record<string, string> = {};

export function registerOpenReplayTracker(tracker: Tracker) {
  activeTracker = tracker;
  if (pendingUserID) {
    tracker.setUserID(pendingUserID);
    pendingUserID = null;
  }
  if (tracker.setMetadata) {
    for (const [key, value] of Object.entries(pendingMetadata)) {
      tracker.setMetadata(key, value);
    }
    for (const key of Object.keys(pendingMetadata)) delete pendingMetadata[key];
  }
}

export function setOpenReplayUserID(id: string) {
  if (activeTracker) {
    activeTracker.setUserID(id);
  } else {
    pendingUserID = id;
  }
}

export function setOpenReplayMetadata(key: string, value: string) {
  if (activeTracker?.setMetadata) {
    activeTracker.setMetadata(key, value);
  } else {
    pendingMetadata[key] = value;
  }
}
