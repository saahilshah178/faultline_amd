"use client";

import { useEffect, useState } from "react";
import type { WorkOrder } from "@/lib/types";

// Approve and Edit are a draft workflow: the state lives in this browser's
// localStorage and goes nowhere else. The generated work order is never changed.

interface Stored {
  base: string; // the generated work order this draft was made from
  draft: WorkOrder | null;
  approved_at: string | null;
}

const storageKey = (alarmId: string) => `faultline:work-order:${alarmId}`;

function read(alarmId: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(storageKey(alarmId));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function write(alarmId: string, value: Stored | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(storageKey(alarmId));
    else window.localStorage.setItem(storageKey(alarmId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const lines = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);

export function WorkOrderPanel({ alarmId, workOrder, origin }: { alarmId: string; workOrder: WorkOrder | null; origin: "cached" | "live" }) {
  const base = workOrder ? JSON.stringify(workOrder) : "";
  const [stored, setStored] = useState<Stored | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<WorkOrder | null>(null);
  const [storageOk, setStorageOk] = useState(true);

  useEffect(() => {
    setStored(read(alarmId));
    setEditing(false);
  }, [alarmId, base]);

  if (!workOrder) {
    return (
      <section className="panel work-order" data-testid="work-order" data-state="missing">
        <header className="section-head">
          <h2>Work order</h2>
        </header>
        <div className="not-generated">
          <strong>Not drafted yet.</strong>
          <p>The work order is drafted by the same model, from the explanation. It will appear here once the pipeline has run on the GPU droplet.</p>
        </div>
      </section>
    );
  }

  const stale = stored !== null && stored.base !== base;
  const current = !stale && stored?.draft ? stored.draft : workOrder;
  const edited = !stale && !!stored?.draft;
  const approvedAt = !stale ? (stored?.approved_at ?? null) : null;

  const save = (next: Stored | null) => {
    setStorageOk(write(alarmId, next));
    setStored(next);
  };

  const startEdit = () => {
    setForm({ ...current, steps: [...current.steps], parts_to_check: [...current.parts_to_check] });
    setEditing(true);
  };

  return (
    <section className="panel work-order" data-testid="work-order" data-state="ready" data-approved={approvedAt ? "1" : "0"} data-edited={edited ? "1" : "0"}>
      <header className="section-head">
        <h2>Work order</h2>
        <span className={`chip chip-${current.priority.toLowerCase()}`} data-testid="work-order-priority">
          {current.priority}
        </span>
        {approvedAt ? <span className="chip chip-good">approved in this browser</span> : <span className="chip chip-muted">draft</span>}
        {edited ? <span className="chip chip-outline">edited in this browser</span> : null}
        {origin === "live" ? <span className="chip chip-live">generated live just now</span> : null}
      </header>
      <p className="draft-note">
        Draft workflow. Edit and Approve are saved in this browser only (local storage); nothing is sent to a maintenance system and the generated draft is kept.
      </p>
      {stale ? (
        <p className="notice">
          The generated work order has changed since you edited or approved it in this browser. Your saved draft is not applied.{" "}
          <button type="button" className="link" onClick={() => save(null)}>
            Discard it
          </button>
        </p>
      ) : null}
      {!storageOk ? <p className="notice">This browser refused to store the draft, so it will be lost when you leave the page.</p> : null}

      {editing && form ? (
        <form
          className="wo-form"
          data-testid="work-order-form"
          onSubmit={(e) => {
            e.preventDefault();
            save({ base, draft: { ...form, steps: lines(form.steps.join("\n")), parts_to_check: lines(form.parts_to_check.join("\n")) }, approved_at: null });
            setEditing(false);
          }}
        >
          <label>
            Title
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="wo-title-input" />
          </label>
          <label>
            Symptom
            <textarea rows={3} value={form.symptom} onChange={(e) => setForm({ ...form, symptom: e.target.value })} />
          </label>
          <label>
            Suspected cause
            <textarea rows={2} value={form.suspected_cause} onChange={(e) => setForm({ ...form, suspected_cause: e.target.value })} />
          </label>
          <label>
            Steps, one per line
            <textarea rows={Math.max(form.steps.length + 1, 5)} value={form.steps.join("\n")} onChange={(e) => setForm({ ...form, steps: e.target.value.split("\n") })} />
          </label>
          <label>
            Parts to check, one per line
            <textarea rows={Math.max(form.parts_to_check.length + 1, 3)} value={form.parts_to_check.join("\n")} onChange={(e) => setForm({ ...form, parts_to_check: e.target.value.split("\n") })} />
          </label>
          <div className="wo-form-row">
            <label>
              Priority
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as WorkOrder["priority"] })}>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </select>
            </label>
            <label className="grow">
              Reason for the priority
              <input value={form.priority_reason} onChange={(e) => setForm({ ...form, priority_reason: e.target.value })} />
            </label>
          </div>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" data-testid="wo-save">
              Save draft
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h3 className="wo-title" data-testid="work-order-title">
            {current.title}
          </h3>
          <dl className="kv-list wo-fields">
            <div className="kv">
              <dt>Asset</dt>
              <dd>{current.asset}</dd>
            </div>
            <div className="kv">
              <dt>Symptom</dt>
              <dd>{current.symptom}</dd>
            </div>
            <div className="kv">
              <dt>Suspected cause</dt>
              <dd>{current.suspected_cause}</dd>
            </div>
            <div className="kv">
              <dt>Priority</dt>
              <dd>
                {current.priority}: {current.priority_reason}
              </dd>
            </div>
          </dl>
          <h3>Steps</h3>
          <ol className="steps">
            {current.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <h3>Parts to check</h3>
          <ul className="parts">
            {current.parts_to_check.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <div className="btn-row">
            {approvedAt ? (
              <span className="approved-at" data-testid="approved-at">
                Approved {approvedAt.replace("T", " ").slice(0, 16)} UTC, in this browser
              </span>
            ) : (
              <button type="button" className="btn btn-primary" data-testid="wo-approve" onClick={() => save({ base, draft: stored && !stale ? stored.draft : null, approved_at: new Date().toISOString() })}>
                Approve
              </button>
            )}
            <button type="button" className="btn" data-testid="wo-edit" onClick={startEdit}>
              Edit
            </button>
            {stored && !stale ? (
              <button type="button" className="btn" data-testid="wo-reset" onClick={() => save(null)}>
                Reset to the generated draft
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
