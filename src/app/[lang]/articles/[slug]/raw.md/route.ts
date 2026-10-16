import { article, articles } from "@/lib/articles";
import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/seo";

/** The article as the Markdown it was written in, for readers that are programs. Built with the page. */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return LANGUAGES.flatMap((lang) => articles(lang).map((item) => ({ lang, slug: item.slug })));
}

export async function GET(_: Request, { params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const found = article(slug, language);
  if (!found) return new Response("Not found", { status: 404 });
  const text = [
    `# ${found.title}`,
    "",
    `> ${found.description}`,
    "",
    `Published ${found.date} · ${absoluteUrl(language, `/articles/${found.slug}`)}`,
    "",
    // A link into the site is written without its address in the document; a program needs the whole one.
    found.markdown.replace(/\]\((\/[^)]*)\)/g, (_, path: string) => `](${absoluteUrl(language, path)})`),
    "",
  ].join("\n");
  // The page, not this copy, is what a search engine should keep.
  const page = absoluteUrl(language, `/articles/${found.slug}`);
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8", Link: `<${page}>; rel="canonical"` } });
}
