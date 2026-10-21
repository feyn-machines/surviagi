/**
 * One X account, however the reader wrote it. Kept free of imports so the unit
 * tests can load the source directly.
 */
export const OWNER_KINDS = ["person", "organization"] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

const HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"]);
/** Paths on x.com that are the site's own pages, not accounts. */
const RESERVED = new Set(["home", "explore", "search", "settings", "i", "intent", "share", "hashtag", "messages", "notifications", "login", "signup", "compose", "tos", "privacy"]);
const NAME = /^[A-Za-z0-9_]{1,15}$/;

/** `handle` as typed (for display), `key` lower-case (for comparison); null when the input is not one account. */
export function normalizeHandle(input: unknown): { handle: string; key: string } | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || /^(www\.|mobile\.)?(x|twitter)\.com\//i.test(text)) {
    // Dot segments, checked on the raw text because URL parsing would resolve them away.
    if (/(^|\/)(\.|%2e){1,2}(\/|$|[?#])/i.test(text)) return null;
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    if (url.port || url.username || url.password || text.includes("\\")) return null;
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !HOSTS.has(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    text = parts[0];
  }
  if (text.startsWith("@")) text = text.slice(1);
  if (!NAME.test(text) || RESERVED.has(text.toLowerCase())) return null;
  return { handle: text, key: text.toLowerCase() };
}
