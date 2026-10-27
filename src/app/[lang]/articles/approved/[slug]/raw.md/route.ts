import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/seo";
import { approvedEditorialArticle } from "@/lib/editorial-store";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const article = await approvedEditorialArticle(slug, language);
  if (!article) return new Response("Not found", { status: 404 });
  const path = `/articles/approved/${slug}`;
  const text = [
    `# ${article.title}`,
    "",
    `> ${article.summary}`,
    "",
    `Approved version ${article.version} · ${article.createdAt.slice(0, 10)} · ${absoluteUrl(language, path)}`,
    "",
    article.markdown.replace(/\]\((\/[^)]*)\)/g, (_, href: string) => `](${absoluteUrl(language, href)})`),
    "",
  ].join("\n");
  return new Response(text, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      Link: `<${absoluteUrl(language, path)}>; rel="canonical"`,
    },
  });
}
