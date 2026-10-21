"use client";

/**
 * Sign-in and sign-out as two plain requests to Better Auth's endpoints (`/api/auth/sign-in/social`
 * answers `{ url, redirect }`; `/api/auth/sign-out` answers `{ success }`), so no Better Auth client
 * code ships to every page.
 */

const SIGN_IN_FAILED = "signin";

/** The address the reader is on, with the failure marker, as a root-relative path (no fragment). */
function failurePath(): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SIGN_IN_FAILED, "failed");
  return `${url.pathname}${url.search}`;
}

/** Starts Google sign-in and leaves the page. Rejects when the request fails, so the caller can say so. */
export async function startSignIn(callbackPath: string): Promise<void> {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: callbackPath, errorCallbackURL: failurePath() }),
  });
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!response.ok || typeof body?.url !== "string") throw new Error("sign-in failed");
  window.location.assign(body.url);
}

/** Ends the session and reloads, whether or not the request got through. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } finally {
    window.location.reload();
  }
}

/** True once when the page was opened by a failed sign-in; the marker is removed from the address. */
export function takeSignInFailure(): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get(SIGN_IN_FAILED) !== "failed") return false;
  for (const name of [SIGN_IN_FAILED, "error", "error_description"]) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}
