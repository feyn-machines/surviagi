import { DEFAULT_LANGUAGE, localizedPath, normalizeLanguage } from "@/lib/i18n";
import { activities, marketSlug } from "@/lib/snapshot";
import { workSlug } from "@/lib/routes";

/** Rendered per request from the loaded data release, like the pages it points at. */
export const dynamic = "force-dynamic";

/** The Markdown copy of a market's work row is the market's Markdown copy; see the page route beside this one. */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const work = activities().find((a) => workSlug(a.activity_id) === id);
  if (!work) return new Response("Not found", { status: 404 });
  const to = `${localizedPath(language, `/markets/${marketSlug(work.market_id)}`)}/raw.md`;
  return new Response(null, { status: 301, headers: { Location: to } });
}
