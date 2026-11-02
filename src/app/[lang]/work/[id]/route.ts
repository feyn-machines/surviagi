import { DEFAULT_LANGUAGE, localizedPath, normalizeLanguage } from "@/lib/i18n";
import { activities, activityAnchor, marketSlug } from "@/lib/snapshot";
import { workSlug } from "@/lib/routes";

/** Rendered per request from the loaded data release, like the pages it points at. */
export const dynamic = "force-dynamic";

/**
 * A kind of work has no page of its own any more: it is a row on its market's
 * page, where the updates that bear on it are listed. The old address stays
 * valid and moves permanently to that row, so links already shared and indexed
 * land on the same content. An address that names no work is a 404, as before.
 */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const work = activities().find((a) => workSlug(a.activity_id) === id);
  if (!work) return new Response("Not found", { status: 404 });
  const to = `${localizedPath(language, `/markets/${marketSlug(work.market_id)}`)}#${activityAnchor(work.activity_id, work.market_id)}`;
  return new Response(null, { status: 301, headers: { Location: to } });
}
