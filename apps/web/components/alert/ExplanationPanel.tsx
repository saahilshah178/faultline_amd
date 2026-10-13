"use client";

import { pageLabel } from "@/lib/labels";
import type { Excerpt, Explanation, KbSource, LlmStats } from "@/lib/types";
import type { CitationTarget } from "./Citations";

const CONFIDENCE: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
const URGENCY: Record<string, string> = { now: "Now", this_shift: "This shift", this_week: "This week" };

interface Props {
  explanation: Explanation | null;
  excerpts: Excerpt[];
  sources: KbSource[];
  llm: LlmStats | null;
  origin: "cached" | "live";
  onCite: (target: CitationTarget) => void;
}

export function ExplanationPanel({ explanation, excerpts, sources, llm, origin, onCite }: Props) {
  if (!explanation) {
    return (
      <section className="panel explanation" data-testid="explanation" data-state="missing">
        <header className="section-head">
          <h2>Explanation</h2>
        </header>
        <div className="not-generated" data-testid="explanation-missing">
          <strong>Not generated yet.</strong>
          <p>
            The explanation for this alarm is written by the language model that runs on the MI300X GPU droplet, and that run has not happened for this data. Nothing is shown in its place. The charts and the evidence on this page are computed directly from the sensor data and do not depend on it.
          </p>
        </div>
      </section>
    );
  }

  const short = (doc: string) => sources.find((s) => s.doc === doc);
  return (
    <section className="panel explanation" data-testid="explanation" data-state="ready" data-origin={origin}>
      <header className="section-head">
        <h2>Explanation</h2>
        <span className={`chip ${origin === "live" ? "chip-live" : "chip-muted"}`}>{origin === "live" ? "generated live just now" : "cached from the pipeline run"}</span>
      </header>
      <p className="summary" data-testid="explanation-summary">
        {explanation.summary}
      </p>

      <h3>Likely causes</h3>
      <ol className="cause-list">
        {explanation.likely_causes.map((c, i) => (
          <li key={i}>
            <div className="item-head">
              <strong>{c.cause}</strong>
              <span className={`chip chip-conf-${c.confidence}`}>{CONFIDENCE[c.confidence] ?? c.confidence}</span>
            </div>
            <p>{c.evidence}</p>
          </li>
        ))}
      </ol>

      <h3>Recommended actions</h3>
      <ol className="action-list">
        {explanation.recommended_actions.map((a, i) => (
          <li key={i}>
            <div className="item-head">
              <strong>{a.action}</strong>
              <span className={`chip chip-urg-${a.urgency}`}>{URGENCY[a.urgency] ?? a.urgency}</span>
            </div>
            <p>{a.why}</p>
          </li>
        ))}
      </ol>

      <h3>Sources cited</h3>
      <ol className="citation-list" data-testid="citations">
        {explanation.citations.map((c, i) => (
          <li key={i}>
            <button
              type="button"
              className="citation"
              data-testid="citation"
              onClick={() => onCite({ doc: c.doc, page: c.page, quote: c.quote, excerpts: excerpts.filter((e) => e.doc === c.doc && e.page === c.page) })}
            >
              <span className="citation-ref">
                {short(c.doc)?.title ?? c.doc}, {pageLabel(short(c.doc), c.page)}
              </span>
              <span className="citation-quote">“{c.quote}”</span>
            </button>
          </li>
        ))}
      </ol>

      {llm ? (
        <p className="provenance" data-testid="explanation-provenance">
          Written by <code>{llm.model}</code>
          {llm.generated_utc ? ` at ${llm.generated_utc.replace("T", " ").replace("Z", " UTC")}` : ""}.
          {llm.citations_validated ? " Every quote was checked word for word against the retrieved pages before this was accepted" : ""}
          {llm.explanation_attempts !== undefined ? ` (accepted on attempt ${llm.explanation_attempts}).` : llm.citations_validated ? "." : ""}
        </p>
      ) : null}
    </section>
  );
}
