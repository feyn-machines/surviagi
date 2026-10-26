import { runMySubmissions, withOwner } from "@/lib/agent-api";
import { outcomeResponse } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET with `Authorization: Bearer <key>`: the key holder's recent requests and quota. */
export async function GET(request: Request) {
  return outcomeResponse(await withOwner(request, runMySubmissions), false);
}
