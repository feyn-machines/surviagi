/** The public address. Not a secret and not per-environment: a candidate build names the same canonical pages. */
export const SITE_URL = "https://surviagi.com";

/**
 * The hosts that are sent to `SITE_URL`: `www.` plus the site's own host, and the address the site had
 * before it was renamed (2026-10-08), with and without `www.`. A reader or a search engine holding an old
 * address lands on the same page at the new one.
 */
const REDIRECTED_HOSTS = new Set([`www.${new URL(SITE_URL).host}`, "openaiwill.com", "www.openaiwill.com"]);

/**
 * Whether `host` (a `Host` header value) is one of the redirected hosts, with or without a port or a
 * trailing dot; no other suffix or prefix matches.
 */
export function isRedirectedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  // A trailing dot and a port name the same host.
  const name = host.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return REDIRECTED_HOSTS.has(name);
}

/** `SITE_URL` + the request's path and query; never built from the Host header. */
export function apexLocation(pathname: string, search: string): string {
  return `${SITE_URL}${pathname}${search}`;
}
