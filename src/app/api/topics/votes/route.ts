import { json, notFound, rateLimit, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { castVote, myVote, quarterOf, voteCounts } from "@/lib/app-store";
import { appPool, currentUser } from "@/lib/auth";
import { topics } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

const MAX_BODY = 1024;

/** A topic of the loaded data release, by id; a vote is only ever about one of these. */
const find = (id: unknown) => (typeof id === "string" ? topics().find((topic) => topic.topic_id === id) : undefined);

/** Readers' votes on one topic by quarter, and this reader's own in the running quarter. Counts are public. */
export async function GET(request: Request) {
  if (!appEnabled()) return notFound();
  const topic = find(new URL(request.url).searchParams.get("topic"));
  if (!topic) return json({ error: "unknown_topic" }, 404);
  const quarter = quarterOf(new Date());
  try {
    const user = await currentUser(request);
    const [counts, mine] = await Promise.all([
      voteCounts(appPool(), topic.topic_id),
      user ? myVote(appPool(), user.id, topic.topic_id, quarter) : Promise.resolve(null),
    ]);
    return json({ quarter, counts, mine });
  } catch (error) {
    console.error(`[votes] read failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}

/** Sets, changes or withdraws (`option: null`) this reader's vote in the running quarter. */
export async function PUT(request: Request) {
  if (!appEnabled()) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  if (!rateLimit(`vote:${user.id}`, 120, 3600_000)) return json({ error: "rate" }, 429);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
    return json({ error: "invalid" }, 400);
  }
  const { topic: topicId, option } = read.value as Record<string, unknown>;
  const topic = find(topicId);
  if (!topic) return json({ error: "unknown_topic" }, 404);
  if (option !== null && !topic.options.some((o) => o.option_id === option)) return json({ error: "unknown_option" }, 400);

  const quarter = quarterOf(new Date());
  try {
    const done = await castVote(appPool(), { userId: user.id, topicId: topic.topic_id, optionId: option as string | null, quarter });
    if (!done) return json({ error: "signed_out" }, 401);
    return json({ quarter, counts: await voteCounts(appPool(), topic.topic_id), mine: option });
  } catch (error) {
    console.error(`[votes] cast failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
