"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Status } from "@/lib/types";

// The pages are built ahead of time from the cached results, so the mode the server
// is running in is asked for at runtime, once, from /api/status.

type StatusState = { status: Status | null; error: boolean };

const StatusContext = createContext<StatusState>({ status: null, error: false });

export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<StatusState>({ status: null, error: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/status", { cache: "no-store" })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json() as Promise<Status>;
      })
      .then((status) => {
        if (!cancelled) setState({ status, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ status: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <StatusContext.Provider value={state}>{children}</StatusContext.Provider>;
}

export function useStatus(): StatusState {
  return useContext(StatusContext);
}
