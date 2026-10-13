"use client";

import { useEffect, useRef } from "react";
import { pageLabel, sourceLink } from "@/lib/labels";
import type { Excerpt, KbSource } from "@/lib/types";

export interface CitationTarget {
  doc: string;
  page: number;
  quote?: string;
  excerpts: Excerpt[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the quote sits in the excerpt, ignoring case, spacing and curly quotes. */
function locate(text: string, quote: string): [number, number] | null {
  const words = quote.trim().replace(/^["'\s]+|["'.,;:\s]+$/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // Tolerate what the validator tolerates: curly quotes, dash variants, soft hyphens,
  // and a word the PDF broke across a line ("com- pressed" for "compressed").
  const one = (ch: string) =>
    /['\u2018\u2019]/.test(ch)
      ? "['\u2018\u2019]"
      : /["\u201c\u201d]/.test(ch)
        ? '["\u201c\u201d]'
        : /[-\u2013\u2014\u2011]/.test(ch)
          ? "[-\u2013\u2014\u2011]"
          : escapeRe(ch);
  const pattern = words.map((w) => [...w].map(one).join("(?:\\u00ad|-\\s)?")).join("[\\s\\u00a0\\u00ad]+");
  try {
    const m = new RegExp(pattern, "i").exec(text);
    return m ? [m.index, m.index + m[0].length] : null;
  } catch {
    return null;
  }
}

function ExcerptText({ excerpt, quote }: { excerpt: Excerpt; quote?: string }) {
  const hit = quote ? locate(excerpt.text, quote) : null;
  if (!hit) return <p className="excerpt-text">{excerpt.text}</p>;
  return (
    <p className="excerpt-text">
      {excerpt.text.slice(0, hit[0])}
      <mark>{excerpt.text.slice(hit[0], hit[1])}</mark>
      {excerpt.text.slice(hit[1])}
    </p>
  );
}

export function CitationDialog({ target, sources, onClose }: { target: CitationTarget | null; sources: KbSource[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (target && !dialog.open) dialog.showModal();
    if (!target && dialog.open) dialog.close();
  }, [target]);

  const source = target ? sources.find((s) => s.doc === target.doc) : undefined;
  const link = target ? sourceLink(source, target.page) : null;
  const printed = target?.excerpts.find((e) => e.printed_page !== null && e.printed_page !== undefined)?.printed_page;

  return (
    <dialog
      ref={ref}
      className="citation-dialog"
      data-testid="citation-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {target ? (
        <div className="citation-body">
          <header>
            <div>
              <span className="eyebrow">Source passage</span>
              <h3>{source?.title ?? target.doc}</h3>
              <p className="muted">
                {source?.publisher ? `${source.publisher}. ` : ""}
                <span data-testid="citation-page">{pageLabel(source, target.page)}</span>
                {printed ? ` (printed page ${printed})` : ""}
              </p>
            </div>
            <button type="button" className="btn" onClick={onClose} aria-label="Close">
              Close
            </button>
          </header>
          {target.quote ? (
            <blockquote data-testid="citation-quote">{target.quote}</blockquote>
          ) : null}
          {target.excerpts.length ? (
            <>
              <span className="eyebrow">{target.quote ? "Where it appears in the retrieved excerpt" : "Retrieved excerpt"}</span>
              {target.excerpts.map((e) => (
                <div key={e.id} className="excerpt">
                  <ExcerptText excerpt={e} quote={target.quote} />
                  <span className="excerpt-id">{e.id}</span>
                </div>
              ))}
            </>
          ) : (
            <p className="muted">The retrieved excerpt for this page was not stored with the alert.</p>
          )}
          {link ? (
            <a className="btn btn-primary" href={link} target="_blank" rel="noreferrer noopener" data-testid="citation-link">
              Open the source at {pageLabel(source, target.page)}
            </a>
          ) : (
            <p className="muted">No source link is recorded for {target.doc}.</p>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
