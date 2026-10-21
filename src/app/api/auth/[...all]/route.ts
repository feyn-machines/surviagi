import { toNextJsHandler } from "better-auth/next-js";
import { NO_STORE_HEADERS, notFound } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Better Auth's answer with the no-cache headers added; Location, status and every Set-Cookie are kept. */
function noStore(original: Response): Response {
  const headers = new Headers();
  original.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers.append(name, value);
  });
  for (const cookie of original.headers.getSetCookie()) headers.append("set-cookie", cookie);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) headers.set(name, value);
  return new Response(original.body, { status: original.status, statusText: original.statusText, headers });
}

function handler(method: "GET" | "POST") {
  return async (request: Request) => {
    if (!appEnabled()) return notFound();
    return noStore(await toNextJsHandler(getAuth())[method](request));
  };
}

export const GET = handler("GET");
export const POST = handler("POST");
