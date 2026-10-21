"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Submission } from "@/lib/app-store";

type Snapshot = { state: "idle" | "ready"; list: Submission[] };

const EMPTY: Submission[] = [];
let snapshot: Snapshot = { state: "idle", list: EMPTY };
let started = false;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** One shared fetch of the signed-in reader's submissions. A signed-out answer is an empty list. */
export async function refreshSubmissions(): Promise<void> {
  started = true;
  try {
    const response = await fetch("/api/submissions", { cache: "no-store" });
    if (response.status === 401) {
      publish({ state: "ready", list: EMPTY });
      return;
    }
    if (!response.ok) throw new Error("list failed");
    const body = (await response.json()) as { submissions: Submission[] };
    publish({ state: "ready", list: body.submissions });
  } catch {
    // Not a final answer: the next refresh or mount tries again.
    started = false;
  }
}

let pageshowRegistered = false;

/** A page restored from the back/forward cache may list submissions of a reader who has since signed out. */
function registerPageshow() {
  if (pageshowRegistered || typeof window === "undefined") return;
  pageshowRegistered = true;
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !started) return;
    publish({ state: "idle", list: EMPTY });
    started = false;
    void refreshSubmissions();
  });
}

const IDLE: Snapshot = { state: "idle", list: EMPTY };

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The shared list; loading starts the first time a signed-in reader (`active`) asks. */
export function useSubmissions(active: boolean): Snapshot {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => IDLE);
  useEffect(() => {
    registerPageshow();
    if (active && !started) void refreshSubmissions();
  }, [active]);
  return active ? current : IDLE;
}
