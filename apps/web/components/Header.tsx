"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStatus } from "./StatusProvider";

const NAV = [
  { href: "/", label: "Plant" },
  { href: "/alerts", label: "Alerts" },
  { href: "/benchmark", label: "Benchmark" },
];

function ModeBadge() {
  const { status, error } = useStatus();
  if (error) {
    return (
      <span className="mode mode-unknown" data-testid="mode-badge" data-mode="unknown" title="/api/status did not answer">
        <i /> Mode unknown
      </span>
    );
  }
  if (!status) {
    return (
      <span className="mode mode-unknown" data-testid="mode-badge" data-mode="loading">
        <i /> Checking mode
      </span>
    );
  }
  if (status.mode === "replay") {
    return (
      <span className="mode mode-replay" data-testid="mode-badge" data-mode="replay" title="Everything shown is read from cached pipeline results. No GPU is called.">
        <i /> Replay <small>cached results, no GPU calls</small>
      </span>
    );
  }
  const ok = status.live_configured && status.droplet_reachable === true;
  const detail = !status.live_configured
    ? "droplet address not configured"
    : status.droplet_reachable
      ? `model server answering${status.llm_model ? `: ${status.llm_model}` : ""}`
      : "model server not reachable";
  return (
    <span className={`mode ${ok ? "mode-live" : "mode-down"}`} data-testid="mode-badge" data-mode="live" data-reachable={String(status.droplet_reachable)}>
      <i /> Live <small>{detail}</small>
    </span>
  );
}

export function Header() {
  const pathname = usePathname();
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M2 14h5l2-7 3 12 3-9 2 4h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="brand-name">Faultline</span>
        <span className="brand-sub">Air production unit, MetroPT-3 recording</span>
      </Link>
      <nav aria-label="Views">
        {NAV.map((item) => {
          const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={current ? "is-current" : ""} aria-current={current ? "page" : undefined}>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <ModeBadge />
    </header>
  );
}
