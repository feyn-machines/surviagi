import { NextResponse, type NextRequest } from "next/server";
import { apexLocation, isRedirectedHost } from "./lib/site-origin";
import { LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE, languageRoute } from "./lib/i18n";

/**
 * Only a top-level navigation is a reader choosing a language. Speculative
 * prefetches and client-side data requests must not rewrite the saved choice
 * or be bounced to another language.
 */
function isNavigation(request: NextRequest) {
  const destination = request.headers.get("sec-fetch-dest");
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return (destination === null || destination === "document") && !purpose.includes("prefetch");
}

const REWRITTEN = "x-openaiwill-rewritten";
// A value only this process knows. A fixed value would let any client send the header and skip
// the language rules (duplicate /en/... pages, no redirects), so only our own rewrite can match.
const MARKER = crypto.randomUUID();

function withMarker(headers: Headers) {
  const marked = new Headers(headers);
  marked.set(REWRITTEN, MARKER);
  return marked;
}

function passThrough() {
  const response = NextResponse.next();
  if (process.env.SITE_ENV !== "production") response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

/**
 * English is served at unprefixed addresses and Chinese under `/zh-CN`; the
 * pages themselves live under `/[lang]`. The rules are in `languageRoute`.
 */
export function proxy(request: NextRequest) {
  // www.<site> and the site's earlier address are sent to the apex before anything else: cookies and the
  // sign-in origin check belong to the apex. Behind the tunnel the app sees the public Host. The Location is the
  // fixed apex origin plus this request's own path and query, never a value taken from a header.
  if (isRedirectedHost(request.headers.get("host"))) {
    return NextResponse.redirect(apexLocation(request.nextUrl.pathname, request.nextUrl.search), 308);
  }
  // `/api/*` reaches this function only for the redirect above; it has no language.
  if (request.nextUrl.pathname.startsWith("/api/")) return passThrough();

  // The server runs this proxy again on the address a rewrite produced. That second
  // pass is ours, not a reader asking for /en/..., so it must not be sent back.
  if (request.headers.get(REWRITTEN) === MARKER) return passThrough();

  const route = languageRoute({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    savedLanguage: request.cookies.get(LANGUAGE_COOKIE)?.value,
    navigation: isNavigation(request),
  });

  let response: NextResponse;
  if (route.kind === "redirect") {
    // `route.location` is a path on this host (see `languageRoute`). Next
    // resolves the Location it is given against the request, so it needs an
    // absolute URL here and turns a same-host one back into a relative Location.
    response = NextResponse.redirect(new URL(route.location, request.url), route.status);
    if (route.save) {
      response.cookies.set({
        name: LANGUAGE_COOKIE,
        value: route.save,
        path: "/",
        maxAge: LANGUAGE_COOKIE_MAX_AGE,
        sameSite: "lax",
      });
    }
  } else if (route.kind === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = route.pathname;
    response = NextResponse.rewrite(url, { request: { headers: withMarker(request.headers) } });
  } else {
    response = NextResponse.next();
  }

  // Only the production service may be indexed; a candidate build must not be.
  if (process.env.SITE_ENV !== "production") response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

/**
 * Files that are not pages are named one by one. "Anything with an extension"
 * would be wrong: occupation addresses such as /occupations/11-1011.00 contain
 * a dot. The 32-hex `.txt` is the IndexNow key file in `public/`. Route handlers
 * under `/api/` have no language: rewritten to `/en/api/...` they would be a 404, so they are
 * matched only to get the host redirect and are then passed through untouched.
 */
export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/|api/|og/|figures/|healthz$|robots\\.txt$|sitemap\\.xml$|llms\\.txt$|icon\\.svg$|[0-9a-f]{32}\\.txt$).*)",
  ],
};
