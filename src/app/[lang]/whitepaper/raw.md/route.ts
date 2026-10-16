import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage } from "@/lib/i18n";
import { SITE_URL, absoluteUrl } from "@/lib/seo";
import { whitepaperMarkdown } from "@/lib/whitepaper";

/** The whitepaper as the Markdown it was written in, for readers that are programs. Built with the page, like it. */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return LANGUAGES.map((lang) => ({ lang }));
}

export async function GET(_: Request, { params }: { params: Promise<{ lang: string }> }) {
  const language = normalizeLanguage((await params).lang) ?? DEFAULT_LANGUAGE;
  const page = absoluteUrl(language, "/whitepaper");
  const body = whitepaperMarkdown(language, page, SITE_URL);
  if (!body) return new Response("Not found", { status: 404 });
  // The page, not this copy, is what a search engine should keep.
  return new Response(`${body}\n\n---\n\n${page}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", Link: `<${page}>; rel="canonical"` },
  });
}
