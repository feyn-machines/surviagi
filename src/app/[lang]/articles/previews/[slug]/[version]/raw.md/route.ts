import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { publicEditorialArticle } from "@/lib/editorial-store";
import { absoluteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ lang: string; slug: string; version: string }> }) {
  const { lang, slug, version } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const match = /^v([1-9][0-9]*)$/.exec(version);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number)) return new Response("Not found", { status: 404 });
  const article = await publicEditorialArticle(slug, number, language);
  if (!article) return new Response("Not found", { status: 404 });
  const path = `/articles/previews/${slug}/v${number}`;
  const state = article.status === "approved"
    ? (language === "en" ? "APPROVED VERSION" : "已批准版本")
    : (language === "en" ? "PUBLIC PREPRINT · NOT APPROVED" : "公开预发布 · 尚未批准");
  const versionLabel = language === "en" ? "Version" : "版本";
  const cutoffLabel = language === "en" ? "Evidence cutoff" : "证据截止时间";
  const publishedLabel = language === "en" ? "Published" : "公开时间";
  const text = [
    `# ${article.title}`,
    "",
    `> ${article.summary}`,
    "",
    `${state} · ${versionLabel} ${article.version} · ${cutoffLabel} ${article.sourceCutoff}`,
    "",
    `${publishedLabel} ${article.createdAt} · ${absoluteUrl(language, path)}`,
    "",
    article.markdown.replace(/\]\((\/[^)]*)\)/g, (_, target: string) => `](${absoluteUrl(language, target)})`),
    "",
  ].join("\n");
  return new Response(text, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${absoluteUrl(language, path)}>; rel="canonical"`,
      "Cache-Control": "no-store",
    },
  });
}
