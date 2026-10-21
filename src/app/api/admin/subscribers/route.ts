import { NO_STORE_HEADERS, json, notFound } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { subscriberRows } from "@/lib/app-store";
import { adminOrNull, appPool } from "@/lib/auth";
import { csv } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  try {
    const rows = await subscriberRows(appPool());
    const body = csv([
      ["email", "name", "language", "topics", "subscribed_at"],
      ...rows.map((row) => [row.email, row.name, row.language, row.topics, row.subscribedAt]),
    ]);
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    return new Response(body, {
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="surviagi-subscribers-${day}.csv"`,
      },
    });
  } catch (error) {
    console.error(`[admin] subscriber list failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
