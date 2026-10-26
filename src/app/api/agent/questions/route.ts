import { runSubmitQuestion, withOwner } from "@/lib/agent-api";
import { bodyArgs, INVALID_BODY, outcomeResponse } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** POST with `Authorization: Bearer <key>` and a JSON object; the fields are those of the MCP tool. The key is checked first. */
export async function POST(request: Request) {
  const outcome = await withOwner(request, async (owner) => {
    const args = await bodyArgs(request);
    return args ? runSubmitQuestion(owner, args) : INVALID_BODY;
  });
  return outcomeResponse(outcome, false);
}
