import { explainAlert } from "@/lib/explain-core";
import { errorResponse, liveSetup, loadAlertContext, HttpError } from "@/lib/server/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST {alarm_id} -> a fresh explanation and work order from the model on the droplet,
// validated the same way as the cached ones. Nothing is written to disk.
export async function POST(request: Request) {
  try {
    const setup = liveSetup();
    const body = (await request.json().catch(() => null)) as { alarm_id?: unknown } | null;
    if (!body) throw new HttpError(400, "Send a JSON body: {\"alarm_id\": \"A001\"}.");
    const { ctx } = loadAlertContext(body.alarm_id);
    const result = await explainAlert(ctx, setup.retriever, setup.llm, setup.prompts, setup.schemas);
    return Response.json({ alarm_id: ctx.alarmId, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
