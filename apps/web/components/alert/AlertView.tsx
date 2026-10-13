"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useStatus } from "@/components/StatusProvider";
import type { ExplainResult } from "@/lib/explain-core";
import { attribution } from "@/lib/labels";
import { fmtDuration, parseWall } from "@/lib/time";
import type { Alert, Excerpt, KbSource, ReplaySignal } from "@/lib/types";
import { AlarmChart, ErrorShares } from "./AlarmChart";
import { ChatPanel } from "./ChatPanel";
import { CitationDialog, type CitationTarget } from "./Citations";
import { EvidencePanel } from "./EvidencePanel";
import { ExplanationPanel } from "./ExplanationPanel";
import { WorkOrderPanel } from "./WorkOrderPanel";

interface Props {
  alert: Alert;
  signals: ReplaySignal[];
  sources: KbSource[];
  extraExcerpts: Excerpt[];
  prev: string | null;
  next: string | null;
}

type LiveResult = ExplainResult & { alarm_id: string };

export function AlertView({ alert, signals, sources, extraExcerpts, prev, next }: Props) {
  const { status } = useStatus();
  const { alarm, evidence } = alert;
  const info = attribution(alarm.attribution);
  const [cite, setCite] = useState<CitationTarget | null>(null);
  const [live, setLive] = useState<LiveResult | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<{ error: string; problems?: string[] } | null>(null);

  const isLive = status?.mode === "live";
  const explanation = live?.explanation ?? alert.explanation;
  const workOrder = live?.work_order ?? alert.work_order;
  const excerpts = live?.retrieval.excerpts ?? alert.retrieval?.excerpts ?? [];
  const origin = live ? "live" : "cached";

  const excerptsById = useMemo(() => {
    const map: Record<string, Excerpt> = {};
    for (const e of [...(alert.retrieval?.excerpts ?? []), ...extraExcerpts]) map[e.id] = e;
    return map;
  }, [alert, extraExcerpts]);

  const regenerate = async () => {
    setRegenerating(true);
    setRegenError(null);
    try {
      const resp = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alarm_id: alarm.id }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) setRegenError({ error: data.error ?? `The server answered HTTP ${resp.status}.`, problems: data.problems });
      else setLive(data as LiveResult);
    } catch {
      setRegenError({ error: "The request did not reach the server." });
    } finally {
      setRegenerating(false);
    }
  };

  const explainRejections = live?.rejections ?? [];

  return (
    <div className="stack alert-view" data-testid="alert-view" data-alarm-id={alarm.id}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/alerts">Alerts</Link>
        <span aria-hidden>/</span>
        <span>{alarm.id}</span>
        <span className="crumbs-nav">
          {prev ? <Link href={`/alerts/${prev}`}>Previous: {prev}</Link> : null}
          {next ? <Link href={`/alerts/${next}`}>Next: {next}</Link> : null}
        </span>
      </nav>

      <header className="panel alert-head">
        <div className="alert-title">
          <h1>
            Alarm {alarm.id}
            <span className="alert-fired"> fired {alarm.fire}</span>
          </h1>
          <div className="chips">
            <span className={`chip chip-attr-${info.kind}`}>{info.long}</span>
            {alarm.during_sustained_load ? <span className="chip chip-outline">fired during sustained compressor load</span> : null}
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Anomaly began</dt>
            <dd>{alarm.onset}</dd>
          </div>
          <div>
            <dt>Alarm fired</dt>
            <dd>{alarm.fire}</dd>
          </div>
          <div>
            <dt>Cleared</dt>
            <dd>{alarm.end}</dd>
          </div>
          <div>
            <dt>Active for</dt>
            <dd>{fmtDuration(alarm.active_minutes)}</dd>
          </div>
          <div>
            <dt>Asset</dt>
            <dd className="asset">{evidence?.asset ?? "n/a"}</dd>
          </div>
        </dl>
        <div className="btn-row">
          <Link className="btn" href={`/?t=${parseWall(alarm.fire) - 1800}`} data-testid="open-in-replay">
            Open the replay 30 min before this alarm
          </Link>
          {isLive ? (
            <button type="button" className="btn btn-primary" onClick={regenerate} disabled={regenerating} data-testid="regenerate">
              {regenerating ? "Asking the model" : live ? "Regenerate live again" : "Regenerate live"}
            </button>
          ) : null}
          {live ? (
            <button type="button" className="btn" onClick={() => setLive(null)} data-testid="show-cached">
              Show the cached version
            </button>
          ) : null}
        </div>
        {isLive && !live && !regenerating && !regenError ? (
          <p className="hint">Regenerate live asks the model on the droplet for a fresh explanation and work order for this alarm. The result is shown here and is not saved.</p>
        ) : null}
        {regenError ? (
          <div className="notice notice-error" data-testid="regenerate-error">
            <strong>Live generation failed.</strong> {regenError.error}
            {regenError.problems?.length ? (
              <ul>
                {regenError.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {live ? (
          <div className="live-result" data-testid="live-result">
            <strong>Live result</strong> from <code>{live.llm.model}</code>:{" "}
            <span data-testid="live-latency">{live.llm.llm_seconds} s of model time</span>,{" "}
            <span data-testid="live-tps">{live.llm.tokens_per_s ?? "n/a"} tokens/s</span>, {live.llm.completion_tokens} tokens written over {live.llm.calls.length} call
            {live.llm.calls.length === 1 ? "" : "s"}; explanation accepted on attempt <span data-testid="live-attempts">{live.llm.explanation_attempts}</span>.
            {explainRejections.length ? (
              <div className="rejections" data-testid="live-rejections">
                The validator rejected {explainRejections.length} repl{explainRejections.length === 1 ? "y" : "ies"} before accepting this one:
                <ul>
                  {explainRejections.flatMap((r) =>
                    r.problems.map((p, i) => (
                      <li key={`${r.purpose}-${r.attempt}-${i}`}>
                        {r.purpose}, attempt {r.attempt}: {p}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="alert-grid">
        <AlarmChart alarmId={alarm.id} signals={signals} topSignals={alarm.top_signals ?? []} />
        <div className="stack alert-side">
          <ErrorShares signals={signals} topSignals={alarm.top_signals ?? []} />
          <ExplanationPanel explanation={explanation} excerpts={excerpts} sources={sources} llm={live ? live.llm : alert.llm} origin={origin} onCite={setCite} />
          <WorkOrderPanel alarmId={alarm.id} workOrder={workOrder} origin={origin} />
          <ChatPanel alarmId={alarm.id} examples={alert.chat_examples ?? []} excerptsById={excerptsById} sources={sources} onCite={setCite} />
        </div>
      </div>

      {evidence ? (
        <EvidencePanel evidence={evidence} signals={signals} />
      ) : (
        <div className="panel empty-state">
          <h2>No evidence pack</h2>
          <p>
            <code>results/alerts/{alarm.id}.json</code> has no <code>evidence</code> block. It is written by <code>python -m faultline.evidence</code>.
          </p>
        </div>
      )}

      <CitationDialog target={cite} sources={sources} onClose={() => setCite(null)} />
    </div>
  );
}
