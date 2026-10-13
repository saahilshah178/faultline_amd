// Shapes of the files the Python pipeline writes under results/. Fields the
// pipeline may not have produced yet are optional or nullable on purpose.

export type Attribution = string; // "F1".."F4" | "buffer:Fx" | "tuning_period" | "false_alarm"

export interface TopSignal {
  signal: string;
  share: number;
  error: number;
}

export interface Alarm {
  id: string;
  fire: string;
  onset: string;
  end: string;
  active_minutes: number;
  attribution: Attribution;
  during_sustained_load: boolean;
  top_signals?: TopSignal[];
  rules?: string[];
}

export interface FailureResult {
  id: string;
  window_start: string;
  window_end: string;
  maintenance: string | null;
  detected: boolean;
  first_alarm: string | null;
  lead_before_start_h: number | null;
  lead_before_maintenance_h: number | null;
  first_alarm_after_window_end?: boolean | null;
  alarms_in_span?: number;
}

export interface MethodSummary {
  failures_detected: number;
  failures_missed?: number;
  detected_before_window_start?: number;
  median_lead_before_start_h?: number | null;
  alarms_total?: number;
  alarms_in_tuning_period?: number;
  false_alarms: number;
  false_alarms_per_week: number;
  false_alarms_per_observed_week?: number;
  false_alarms_during_sustained_load?: number;
}

export interface RuleParams {
  threshold: number;
  quantile?: number;
  duration_s: number;
  unit?: string;
}

export interface Method {
  key: string;
  label: string;
  kind: "detector" | "baseline" | string;
  // detector: {threshold, threshold_quantile, duration_s, smoothing}; baseline: {rule: RuleParams}
  params: Record<string, unknown>;
  failures: FailureResult[];
  summary: MethodSummary;
  alarms: Alarm[];
}

export interface Bench {
  generated_utc?: string;
  dataset?: { name?: string; source?: string; license?: string; rows?: number; start?: string; end?: string; interval_s?: number };
  protocol?: {
    training_cutoff?: string;
    lead_horizon_h?: number;
    post_buffer_h?: number;
    alarm_clear_s?: number;
    tuning?: { max_other_alarms?: number; sustained_load_min_s?: number; objective?: string; delay_cap_s?: number };
    evaluation_period?: { start?: string; end?: string; calendar_weeks?: number; observed_weeks?: number; excluded_hours?: number };
  };
  pre_failure_sustained_load_episodes?: { start: string; end: string; minutes: number }[];
  sustained_load_episodes_total?: number;
  training?: {
    hardware?: { device?: string | null; torch?: string | null; hip?: string | null; cuda?: string | null; gpu_name?: string | null; gpu_memory_gb?: number | null };
    trained_on_mi300x?: boolean;
    train_seconds_total?: number;
    train_seconds_final_model?: number;
    score_windows_per_second?: number;
    parameters?: number;
    windows_scored?: number;
    share_of_rows_scored?: number;
    config?: Record<string, unknown>;
    run?: { finished_utc?: string; host?: string; platform?: string; git_commit?: string; smoke?: boolean };
  };
  methods: Method[];
  sensitivity?: {
    lead_horizon_h?: Record<
      string,
      Record<string, { failures_detected: number; false_alarms: number; false_alarms_per_week: number; lead_before_start_h?: Record<string, number | null> }>
    >;
  };
}

export interface RangeStats {
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface SignalEvidence {
  signal?: string;
  share_of_error?: number;
  unit?: string;
  window?: RangeStats;
  normal_p05_p95?: [number, number];
  under_load?: RangeStats & { normal_p05_p95?: [number, number]; verdict?: string };
}

export interface Evidence {
  alarm_id: string;
  asset?: string;
  fired_at?: string;
  anomaly_began?: string;
  minutes_from_onset_to_alarm?: number;
  window?: { start: string; end: string; minutes: number };
  detector?: { score_at_alarm: number; threshold: number; score_over_threshold: number };
  top_contributing_signals?: SignalEvidence[];
  signals?: Record<string, SignalEvidence>;
  compressor_duty?: {
    under_load_share_last_30min?: number | null;
    under_load_share_last_60min?: number | null;
    under_load_share_last_2h?: number | null;
    normal_under_load_share_30min?: { p50: number; p95: number; p99: number };
    continuous_load_minutes_at_alarm?: number | null;
    longest_loaded_run_minutes_last_60min?: number | null;
    normal_loaded_run_minutes?: { p50: number; p95: number; p99: number };
    load_starts_last_2h?: number | null;
    normal_starts_per_hour?: { p50: number; p95: number };
    state_share_last_60min?: { off: number; offloaded: number; loaded: number };
  };
  digital_signals?: Record<string, { share_on_last_60min: number | null; normal_share_on: number | null; switches_last_60min: number | null }>;
  trend?: Record<string, number | null>;
  data_quality?: { rows_in_window?: number; share_of_window_logged?: number };
}

export type Confidence = "high" | "medium" | "low";
export type Urgency = "now" | "this_shift" | "this_week";

export interface Citation {
  doc: string;
  page: number;
  quote: string;
}

export interface Explanation {
  summary: string;
  likely_causes: { cause: string; evidence: string; confidence: Confidence }[];
  recommended_actions: { action: string; why: string; urgency: Urgency }[];
  citations: Citation[];
}

export interface WorkOrder {
  title: string;
  asset: string;
  symptom: string;
  suspected_cause: string;
  steps: string[];
  parts_to_check: string[];
  priority: "P1" | "P2" | "P3";
  priority_reason: string;
}

export interface Excerpt {
  id: string;
  doc: string;
  page: number;
  printed_page: number | null;
  text: string;
  similarity?: number;
}

export interface ChatCitation {
  doc: string;
  page: number;
  chunk_ids: string[];
}

export interface ChatExample {
  question: string;
  answer: string;
  citations: ChatCitation[];
}

export interface LlmCall {
  purpose: string;
  attempt: number;
  latency_s: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens_per_s: number;
}

export interface LlmStats {
  model: string;
  generated_utc?: string;
  explanation_attempts?: number;
  citations_validated?: boolean;
  calls?: LlmCall[];
  wall_seconds?: number;
  llm_seconds?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  tokens_per_s?: number | null;
}

export interface Alert {
  alarm: Alarm;
  evidence: Evidence;
  explanation: Explanation | null;
  work_order: WorkOrder | null;
  chat_examples: ChatExample[] | null;
  retrieval: { queries: string[]; excerpts: Excerpt[] } | null;
  llm: LlmStats | null;
}

export interface KbSource {
  doc: string;
  title: string;
  publisher?: string;
  url: string;
  page_label?: string;
  chunks?: number;
  pages_indexed?: number;
}

export interface LlmSummary {
  generated_utc?: string;
  model?: string | null;
  alerts?: number;
  calls?: number;
  calls_rejected_and_retried?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  tokens_per_s?: { note?: string; median?: number | null; p10?: number | null; p90?: number | null; aggregate?: number | null };
  seconds_per_alert?: { note?: string; median?: number | null; max?: number | null };
  gpu_price?: { usd_per_hour?: number; instance?: string; source?: string };
  usd_per_alert?: { one_at_a_time?: number; note?: string } | null;
  batch?: { alerts?: number; wall_seconds?: number; usd_per_alert?: number; note?: string } | null;
}

// --- replay ------------------------------------------------------------------

export interface ReplaySignal {
  key: string;
  label: string;
  unit: string;
}

export interface ReplayAlarm {
  id: string;
  fire: number;
  end: number;
  attribution: Attribution;
  rules?: string[];
}

export interface ReplayFailure {
  id: string;
  start: number;
  end: number;
  maintenance: number | null;
}

export interface ReplayDayMeta {
  date: string;
  coverage: number;
  loaded: number | null;
  oil_mean: number | null;
  score_max: number | null;
}

export interface ReplayManifest {
  generated_utc?: string;
  step_s: number;
  start: number;
  end: number;
  signals: ReplaySignal[];
  detector: { threshold: number; duration_s: number };
  failures: ReplayFailure[];
  alarms: Record<string, ReplayAlarm[]>;
  methods: { key: string; label: string }[];
  days: ReplayDayMeta[];
}

export interface ReplayDay {
  date: string;
  t0: number;
  step: number;
  n: number;
  signals: Record<string, (number | null)[]>;
  loaded: (number | null)[];
  score: (number | null)[];
}

export interface AlarmWindow {
  id: string;
  fire: number;
  onset: number;
  end: number;
  threshold: number;
  t: number[];
  signals: Record<string, (number | null)[]>;
  score: (number | null)[];
  errors: Record<string, (number | null)[]>;
}

export interface Status {
  mode: "replay" | "live";
  live_configured: boolean;
  droplet_reachable: boolean | null;
  kb_embeddings?: boolean;
  llm_model?: string | null;
}
