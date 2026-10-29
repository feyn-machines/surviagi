import { agentPackage } from "@/lib/agent-packages";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const archive = agentPackage(file);
  if (!archive) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
