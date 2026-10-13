import { hasEmbeddings } from "@/lib/server/data";
import { liveConfig, mode, probe } from "@/lib/server/llm";
import type { Status } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const current = mode();
  const { config } = liveConfig();
  const status: Status = {
    mode: current,
    live_configured: config !== null,
    // Only probed in live mode. In replay mode the app makes no outside calls at all.
    droplet_reachable: current === "live" && config ? await probe(config) : current === "live" ? false : null,
    kb_embeddings: hasEmbeddings(),
    llm_model: current === "live" && config ? config.llmModel : null,
  };
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
