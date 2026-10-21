"use client";

import { useEffect, useSyncExternalStore } from "react";

export type Me = {
  enabled: boolean;
  user: { name: string; email: string; image: string | null } | null;
  admin: boolean;
  /** null when the lookup failed: the state is unknown, not "subscribed to nothing". */
  subscriptions: { updates: boolean; weekly: boolean } | null;
};

type Snapshot = { state: "loading" | "ready"; me: Me };

const EMPTY: Me = { enabled: false, user: null, admin: false, subscriptions: { updates: false, weekly: false } };
let snapshot: Snapshot = { state: "loading", me: EMPTY };
let started = false;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** One shared fetch of /api/me; every component that asks gets the same answer. */
export async function refreshMe(): Promise<void> {
  started = true;
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    const body = response.ok ? ((await response.json()) as Me) : EMPTY;
    publish({ state: "ready", me: body });
  } catch {
    publish({ state: "ready", me: EMPTY });
  }
}

let pageshowRegistered = false;

/** A page restored from the back/forward cache may still show a signed-in reader who has since signed out. */
function registerPageshow() {
  if (pageshowRegistered || typeof window === "undefined") return;
  pageshowRegistered = true;
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void refreshMe();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const loading: Snapshot = { state: "loading", me: EMPTY };
const off: Snapshot = { state: "ready", me: EMPTY };

/** The shared answer of /api/me. With `enabled` false nothing is requested and the answer is "not signed in". */
export function useMe(enabled: boolean): Snapshot {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => loading);
  useEffect(() => {
    if (!enabled) return;
    registerPageshow();
    if (!started) void refreshMe();
  }, [enabled]);
  return enabled ? current : off;
}
