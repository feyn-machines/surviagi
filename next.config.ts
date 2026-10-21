import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Statically typed links. Three `href` strings pointed at routes that had
   * been deleted - `/updates` in the header on every page, `/updates` again on
   * the homepage, `/domains/:id` in a component - and every one of them
   * survived a full `pnpm check`, because nothing in the suite reads an href.
   * A dead link renders as a working link and only fails for the reader.
   *
   * With this on, `typecheck` rejects an href that no route serves, so the
   * check that catches it is the one that already runs.
   *
   * The pages sit under `/[lang]`, so the generated route tree only knows
   * `/en/...` and `/zh-CN/...` addresses and a bare `href="/markets"` is
   * rejected. Links go through `href()` in `src/lib/routes.ts`, which checks the
   * path as it would be under `/en` and adds the reader's language prefix, so
   * the guarantee above holds for every link built that way.
   */
  typedRoutes: true,

  /** The 404 for addresses no route matches, which no layout can render around. */
  experimental: { globalNotFound: true },

  /**
   * A self-contained server for the release directory. Pages render per request
   * from the data release the server loads at start (see `src/instrumentation.ts`),
   * so the snapshot, local data and documents are not copied next to the server.
   * `scripts/site_release.py` checks the assembled directory as well.
   */
  output: "standalone",
  /** The database client is loaded by Node at run time, not bundled; tracing still copies it into the standalone output. */
  serverExternalPackages: ["pg"],
  // No page uses the image optimizer, and its native `sharp` binary would be built for this machine, not the server's architecture.
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    "/**": ["./datasets/**", "./data/**", "./local/**", "./docs/**", "./design/**", "./output/**", "./db/**", "./scripts/**"],
    // Next's own server pulls in `sharp`; it is traced under this key, not under the routes' glob.
    "next-server": ["**/node_modules/sharp/**/*", "**/node_modules/@img/**/*", "**/node_modules/.pnpm/sharp@*/**/*", "**/node_modules/.pnpm/@img+*/**/*"],
  },
};

export default nextConfig;
