import { type ChatMessage, answerQuestion } from "@/lib/explain-core";
import { errorResponse, liveSetup, loadAlertContext, HttpError } from "@/lib/server/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_QUESTION = 600;
const MAX_HISTORY = 12;
const MAX_TURN = 4000;

function cleanHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  const turns: ChatMessage[] = [];
  for (const turn of history.slice(-MAX_HISTORY)) {
    const role = (turn as { role?: unknown })?.role;
    const content = (turn as { content?: unknown })?.content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      turns.push({ role, content: content.slice(0, MAX_TURN) });
    }
  }
  return turns;
}

// POST {alarm_id, question, history[]} -> an answer from the model on the droplet.
// The answer is checked before it is returned (every inline citation must point at a
// retrieved page; otherwise the model is asked again), so it is not streamed.
export async function POST(request: Request) {
  try {
    const setup = liveSetup();
    const body = (await request.json().catch(() => null)) as { alarm_id?: unknown; question?: unknown; history?: unknown } | null;
    if (!body) throw new HttpError(400, "Send a JSON body: {\"alarm_id\", \"question\", \"history\"}.");
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) throw new HttpError(400, "question is required.");
    if (question.length > MAX_QUESTION) throw new HttpError(400, `Keep the question under ${MAX_QUESTION} characters.`);
    const { chatCtx } = loadAlertContext(body.alarm_id);

    const t0 = performance.now();
    const answer = await answerQuestion(chatCtx, question, setup.retriever, setup.llm, setup.prompts, cleanHistory(body.history));
    const llmSeconds = answer.calls.reduce((n, c) => n + c.latency_s, 0);
    const outTokens = answer.calls.reduce((n, c) => n + c.completion_tokens, 0);
    return Response.json(
      {
        alarm_id: chatCtx.alarmId,
        question: answer.question,
        answer: answer.answer,
        citations: answer.citations,
        excerpts: answer.excerpts,
        attempts: answer.attempts,
        rejections: answer.rejections,
        llm: {
          model: setup.llm.model,
          calls: answer.calls,
          wall_seconds: Math.round((performance.now() - t0) / 10) / 100,
          llm_seconds: Math.round(llmSeconds * 100) / 100,
          completion_tokens: outTokens,
          tokens_per_s: llmSeconds ? Math.round((outTokens / llmSeconds) * 100) / 100 : null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
