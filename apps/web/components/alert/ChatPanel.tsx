"use client";

import { useState } from "react";
import { useStatus } from "@/components/StatusProvider";
import type { ChatExample, Excerpt, KbSource } from "@/lib/types";
import type { CitationTarget } from "./Citations";

interface Turn {
  question: string;
  answer: string | null;
  source: "cached" | "live";
  excerpts: Excerpt[];
  error?: string;
  stats?: { llm_seconds?: number; tokens_per_s?: number | null; model?: string };
  rejected?: number;
}

interface Props {
  alarmId: string;
  examples: ChatExample[];
  excerptsById: Record<string, Excerpt>;
  sources: KbSource[];
  onCite: (target: CitationTarget) => void;
}

const INLINE = /\[(doe-sourcebook|apu-description) p\.\s?(\d+)\]/g;

/** Answer text with its inline [doc p.N] citations turned into buttons. */
function AnswerText({ text, excerpts, sources, onCite }: { text: string; excerpts: Excerpt[]; sources: KbSource[]; onCite: (t: CitationTarget) => void }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const doc = m[1];
    const page = parseInt(m[2], 10);
    parts.push(text.slice(last, m.index));
    const label = sources.find((s) => s.doc === doc)?.page_label ?? "page";
    parts.push(
      <button
        key={`${m.index}-${doc}-${page}`}
        type="button"
        className="inline-cite"
        data-testid="chat-citation"
        title={`Open ${doc}, ${label} ${page}`}
        onClick={() => onCite({ doc, page, excerpts: excerpts.filter((e) => e.doc === doc && e.page === page) })}
      >
        {doc} p.{page}
      </button>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className="chat-answer">{parts}</p>;
}

export function ChatPanel({ alarmId, examples, excerptsById, sources, onCite }: Props) {
  const { status } = useStatus();
  const live = status?.mode === "live";
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const askCached = (qa: ChatExample) => {
    const excerpts = (qa.citations ?? []).flatMap((c) => (c.chunk_ids ?? []).map((id) => excerptsById[id]).filter(Boolean));
    setTurns((prev) => [...prev, { question: qa.question, answer: qa.answer, source: "cached", excerpts }]);
  };

  const askLive = async (question: string) => {
    const history = turns.filter((t) => t.answer).flatMap((t) => [
      { role: "user", content: t.question },
      { role: "assistant", content: t.answer as string },
    ]);
    const index = turns.length;
    setTurns((prev) => [...prev, { question, answer: null, source: "live", excerpts: [] }]);
    setBusy(true);
    const patch = (next: Partial<Turn>) => setTurns((prev) => prev.map((t, i) => (i === index ? { ...t, ...next } : t)));
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alarm_id: alarmId, question, history }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        patch({ error: data.error ?? `The server answered HTTP ${resp.status}.` });
      } else {
        patch({ answer: data.answer, excerpts: data.excerpts ?? [], stats: data.llm, rejected: (data.rejections ?? []).length });
      }
    } catch {
      patch({ error: "The request did not reach the server." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel chat" data-testid="chat" data-mode={live ? "live" : "replay"}>
      <header className="section-head">
        <h2>Ask about this alarm</h2>
        <span className={`chip ${live ? "chip-live" : "chip-muted"}`}>{live ? "live: answered by the model now" : "replay: cached answers only"}</span>
      </header>

      {examples.length ? (
        <div className="chat-examples">
          <span className="eyebrow">Questions answered when the pipeline ran</span>
          {examples.map((qa, i) => (
            <button key={i} type="button" className="chat-example" data-testid="chat-example" onClick={() => askCached(qa)}>
              {qa.question}
            </button>
          ))}
        </div>
      ) : (
        <p className="not-generated-inline" data-testid="chat-no-examples">
          No cached answers yet. The standard technician questions are answered by the model when the pipeline runs on the GPU droplet.
        </p>
      )}

      {turns.length ? (
        <ol className="chat-log" data-testid="chat-log">
          {turns.map((t, i) => (
            <li key={i} data-source={t.source}>
              <p className="chat-question">{t.question}</p>
              {t.error ? (
                <p className="notice notice-error" data-testid="chat-error">
                  {t.error}
                </p>
              ) : t.answer === null ? (
                <p className="chat-wait">Waiting for the model</p>
              ) : (
                <>
                  <AnswerText text={t.answer} excerpts={t.excerpts} sources={sources} onCite={onCite} />
                  <p className="chat-meta" data-testid="chat-meta">
                    {t.source === "cached" ? "Cached answer from the pipeline run." : "Answered live."}
                    {t.stats?.llm_seconds !== undefined ? ` ${t.stats.llm_seconds} s` : ""}
                    {t.stats?.tokens_per_s ? `, ${t.stats.tokens_per_s} tokens/s` : ""}
                    {t.rejected ? `. ${t.rejected} earlier repl${t.rejected > 1 ? "ies were" : "y was"} rejected for citing a page that was not retrieved.` : ""}
                  </p>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          const question = draft.trim();
          if (!question || !live || busy) return;
          setDraft("");
          void askLive(question);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!live || busy}
          maxLength={600}
          placeholder={live ? "Ask a question about this alarm" : "Free-form questions need live mode"}
          aria-label="Question"
          data-testid="chat-input"
        />
        <button type="submit" className="btn btn-primary" disabled={!live || busy || !draft.trim()} data-testid="chat-send">
          Ask
        </button>
      </form>
      {!live ? (
        <p className="hint" data-testid="chat-replay-note">
          Free-form questions need live mode, with the GPU droplet running. In replay mode this console makes no model calls: it can only show answers that were generated when the pipeline ran.
        </p>
      ) : (
        <p className="hint">Answers use this alarm's evidence and passages retrieved from the manual. A reply that cites a page it was not given is rejected and asked for again.</p>
      )}
    </section>
  );
}
