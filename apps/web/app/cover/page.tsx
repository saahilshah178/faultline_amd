import type { Metadata } from "next";
import { AlarmChart } from "@/components/alert/AlarmChart";
import { loadAlarms, loadAlert, loadManifest } from "@/lib/server/data";
import { INK, STATUS } from "@/lib/theme";

// A 1200x630 card for the submission cover image. The chart is the real alarm
// window of the first alarm credited to failure F2, drawn by the same component
// as the alert view. `pnpm cover` screenshots this page into docs/cover.png.

export const metadata: Metadata = { title: "Cover", robots: { index: false } };

export default function CoverPage() {
  const alarm = loadAlarms().find((a) => a.attribution === "F2") ?? loadAlarms()[0];
  const alert = alarm ? loadAlert(alarm.id) : null;
  const signals = loadManifest()?.signals ?? [];

  return (
    <div
      data-testid="cover"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        width: 1200,
        height: 630,
        background: INK.plane,
        color: INK.primary,
        display: "grid",
        gridTemplateColumns: "400px 1fr",
        gap: 28,
        padding: "44px 40px 36px 48px",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {/* A still image has no cursor: drop the charts' cursor readout row. */}
      <style>{`[data-testid="cover"] .u-legend .u-series:first-child { display: none; }`}</style>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={STATUS.warning} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12h4l2-5 4 12 3-9 2 4h5" />
            </svg>
            <span style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.02em" }}>Faultline</span>
          </div>
          <p style={{ fontSize: 25, lineHeight: 1.3, margin: "26px 0 0", color: INK.primary }}>
            A maintenance copilot for an industrial air compressor.
          </p>
          <p style={{ fontSize: 17, lineHeight: 1.5, margin: "18px 0 0", color: INK.secondary }}>
            It spots the leak that conventional alarm limits miss, explains the likely cause from the manual, and drafts the work order.
          </p>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, lineHeight: 1.7, color: INK.muted }}>
          <div style={{ color: INK.secondary }}>PyTorch on ROCm · vLLM · gpt-oss-120b</div>
          <div>on one AMD Instinct MI300X</div>
        </div>
      </div>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {alarm && alert ? (
          <>
            <div style={{ fontSize: 14, color: INK.secondary, marginBottom: 8 }}>
              Real sensor data, Porto metro train: an air leak begins and Faultline raises alarm {alarm.id}.
            </div>
            <AlarmChart
              alarmId={alarm.id}
              signals={signals}
              topSignals={alert.alarm.top_signals ?? []}
              panels={["score", "bar"]}
              heights={{ score: 120, bar: 230 }}
            />
          </>
        ) : (
          <p style={{ color: INK.muted }}>No alarm data. Run the pipeline, then rebuild.</p>
        )}
      </div>
    </div>
  );
}
