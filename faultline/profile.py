"""Normal operating profile of the air production unit, from pre-failure data only.

    python -m faultline.profile

Writes results/eda/normal_profile.json (used by the evidence packs as the "normal
range" for each signal) and regenerates docs/apu_description.md, whose section 6
quotes those numbers.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from faultline.alarms import LOADED_CURRENT_A, _runs, sustained_load_episodes, to_seconds
from faultline.config import REPO_ROOT, RESULTS_DIR
from faultline.data import ANALOG_SIGNALS, DIGITAL_SIGNALS, load
from faultline.failures import FIRST_FAILURE_START, GAP_S, assert_pre_failure

PROFILE_JSON = RESULTS_DIR / "eda" / "normal_profile.json"
APU_DOC = REPO_ROOT / "docs" / "apu_description.md"

OFF_CURRENT_A = 1.0
STATES = ("off", "offloaded", "loaded")


def compressor_state(motor_current: np.ndarray) -> np.ndarray:
    """0 = off, 1 = running offloaded, 2 = running under load."""
    return np.where(motor_current > LOADED_CURRENT_A, 2, np.where(motor_current > OFF_CURRENT_A, 1, 0))


def pct(values: np.ndarray, qs: tuple[float, ...]) -> dict[str, float]:
    if len(values) == 0:
        return {f"p{int(q * 100):02d}": None for q in qs}
    return {f"p{int(q * 100):02d}": round(float(v), 3) for q, v in zip(qs, np.quantile(values, qs))}


def duty_by_window(index: pd.DatetimeIndex, loaded: np.ndarray, rule: str = "30min") -> np.ndarray:
    """Share of logged samples under load per window, for windows that are mostly logged."""
    s = pd.Series(loaded.astype("float32"), index=index)
    grouped = s.resample(rule)
    share, count = grouped.mean(), grouped.count()
    full = pd.Timedelta(rule).total_seconds() / 10
    return share[count >= 0.8 * full].to_numpy()


def build_profile(pre: pd.DataFrame) -> dict:
    """Profile of normal operation: pre-failure data minus the sustained-load episodes."""
    assert_pre_failure(pre.index, "build_profile")
    proxies = sustained_load_episodes(pre.index, pre["Motor_current"].to_numpy())
    all_ts = to_seconds(pre.index)
    in_episode = np.zeros(len(pre), dtype=bool)
    for start, end in proxies:
        in_episode |= (all_ts >= start) & (all_ts <= end)
    normal = pre.loc[~in_episode]

    ts = to_seconds(normal.index)
    current = normal["Motor_current"].to_numpy()
    state = compressor_state(current)
    loaded = state == 2

    starts, ends, on = _runs(ts, loaded)
    run_min = (ts[ends] - ts[starts])[on] / 60.0
    load_starts = ts[starts][on]
    periods = np.diff(load_starts) / 60.0
    periods = periods[periods < 240]  # ignore pauses in service

    hours = pd.Series(1, index=pd.to_datetime(load_starts, unit="s")).resample("1h").sum()
    logged_per_hour = pd.Series(1, index=normal.index).resample("1h").sum()
    starts_per_hour = hours.reindex(logged_per_hour.index, fill_value=0)[logged_per_hour >= 300]

    reservoirs = normal["Reservoirs"].to_numpy()
    dt = np.diff(ts)
    with np.errstate(divide="ignore", invalid="ignore"):
        falling = np.where(dt <= GAP_S, (reservoirs[:-1] - reservoirs[1:]) / (dt / 60.0), np.nan)
    falling = falling[np.isfinite(falling) & ~loaded[1:]]

    qs = (0.01, 0.05, 0.50, 0.95, 0.99)
    profile = {
        "source": f"MetroPT-3, rows before {FIRST_FAILURE_START}, excluding sustained-load episodes",
        "rows": len(normal),
        "days_of_logged_data": round(len(normal) * 10 / 86400, 1),
        "sustained_load_episodes_excluded": len(proxies),
        "sustained_load_share_of_time": round(float(in_episode.mean()), 4),
        "state_share": {name: round(float((state == i).mean()), 4) for i, name in enumerate(STATES)},
        "signals": {
            sig: {
                "overall": pct(normal[sig].to_numpy(), qs),
                **{
                    name: pct(normal[sig].to_numpy()[state == i], (0.05, 0.50, 0.95))
                    for i, name in enumerate(STATES)
                },
            }
            for sig in ANALOG_SIGNALS
        },
        "loaded_run_minutes": pct(run_min, (0.50, 0.95, 0.99)),
        "cycle_period_minutes": pct(periods, (0.25, 0.50, 0.75)),
        "duty_30min": pct(duty_by_window(normal.index, loaded), (0.50, 0.95, 0.99)),
        "starts_per_hour": pct(starts_per_hour.to_numpy(), (0.50, 0.95)),
        "reservoir_fall_bar_per_min_not_loaded": pct(falling, (0.50, 0.95, 0.99)),
        "digital_share_on": {sig: round(float(normal[sig].mean()), 4) for sig in DIGITAL_SIGNALS},
    }
    return profile


APU_TEMPLATE = """\
# The MetroPT-3 air production unit

This note describes the machine Faultline monitors. Sections 1 to 5 restate, in
our own words, what the dataset authors document (the MetroPT-3 record in the UCI
Machine Learning Repository, dataset 791, and Veloso et al., "The MetroPT dataset
for predictive maintenance", Scientific Data 9, 764, 2022, arXiv:2207.05466).
Section 6 is measured by `python -m faultline.profile` from the data recorded
before the first reported failure; do not edit its numbers by hand.

## 1. What the unit is

The air production unit (APU) is the compressed air plant of a metro train
operated in Porto, Portugal. It is mounted on the vehicle and supplies the
pneumatic consumers of the train, which the dataset authors list as including
the brakes and the suspension. The authors note that the unit has no redundancy,
so a failure takes the train out of service for repair. The unit consists of an
oil-lubricated compressor driven by a three-phase electric motor, a cyclonic
separator filter, a twin-tower air dryer, a pneumatic panel, and air reservoirs
downstream of it.

## 2. How the unit cycles

The compressor does not run continuously. A pressure switch signal (MPG) starts
the compressor under load when the pressure in the unit falls below 8.2 bar; the
compressor then fills the reservoirs, unloads, and stops until the pressure
falls again. A second switch (LPS) trips if the pressure drops below 7 bar, which
should not happen in normal service. The motor current tells the three operating
states apart: close to 0 A when the motor is off, about 4 A when it runs
offloaded, about 7 A when it runs under load, and about 9 A for a moment at
start. Two dryer towers alternate: one dries the air while the other is
regenerated and drains the moisture it removed.

## 3. Analog signals

Seven analog signals are logged every 10 seconds. TP2 (bar) is the pressure at
the compressor. TP3 (bar) is the pressure at the pneumatic panel. H1 (bar) is
the pressure that falls when the cyclonic separator filter discharges. DV
pressure (bar) is the pressure drop produced when the dryer towers discharge;
the documentation states that it reads zero while the compressor works under
load. Reservoirs (bar) is the pressure downstream of the reservoirs, which
should stay close to TP3. Oil temperature (degrees Celsius) is the temperature
of the compressor oil. Motor current (A) is the current of one phase of the
motor.

## 4. Digital signals

Eight on/off signals are logged with the analog ones. COMP is the intake valve
signal: it is active when no air is being taken in, meaning the compressor is
off or offloaded. DV electric controls the compressor outlet valve and is active
while the compressor works under load. TOWERS says which dryer tower is drying
(inactive for tower one, active for tower two). MPG is the start-under-load
signal described in section 2. LPS is the low pressure switch (below 7 bar).
Pressure switch detects the discharge of the dryer towers. Oil level is active
when the compressor oil is below the expected level. Caudal impulses carries
the pulses of the flow meter that measures air delivered to the reservoirs.

## 5. Failure modes reported by the dataset authors

For the 2020 recording used here, the operator reported four failures, all
classed as air leaks of high severity. In their paper on a later recording of
the same kind of unit, the authors describe two kinds of air leak: one at the
air dryer, where a pneumatic pilot valve malfunctions and lets air escape
through the drain pipes while the compressor is running, and one on a pipe
feeding the pneumatic consumers of the train. They also report an oil leak at
the compressor. They point out that such failures are typically not caught by
predefined thresholds on individual signals.

## 6. Normal operating profile before the first failure

Measured on {days} days of logged data before {cutoff}, leaving out {episodes}
unreported episodes in which the compressor stayed under load for more than 20
minutes without a break ({episode_share:.1%} of the logged time before that
date). In normal operation the compressor was off {off:.0%} of the logged time,
running offloaded {offloaded:.0%} and under load {loaded:.0%}. A normal loaded
run lasted {run_p50:.1f} minutes at the median; 95% of runs were shorter than
{run_p95:.1f} minutes and 99% shorter than {run_p99:.1f} minutes. The time from
one load start to the next was {cycle_p50:.0f} minutes at the median (middle
half: {cycle_p25:.0f} to {cycle_p75:.0f} minutes). Over any half hour the
compressor was under load {duty_p50:.0%} of the time at the median and
{duty_p95:.0%} at the 95th percentile. While the compressor was under load, DV
pressure stayed between {dv_lo:.2f} and {dv_hi:.2f} bar (5th to 95th
percentile) and TP2 between {tp2_lo:.1f} and {tp2_hi:.1f} bar. Reservoir
pressure stayed between {res_lo:.1f} and {res_hi:.1f} bar (1st to 99th
percentile). Oil temperature was {oil_p50:.0f} degrees Celsius at the median,
{oil_p95:.0f} at the 95th percentile and {oil_p99:.0f} at the 99th. Motor
current under load was {cur_lo:.1f} to {cur_hi:.1f} A. The low pressure switch
(LPS) was active {lps:.2%} of the time.
"""


def render_apu_doc(p: dict) -> str:
    s = p["signals"]
    return APU_TEMPLATE.format(
        days=p["days_of_logged_data"],
        cutoff=FIRST_FAILURE_START.strftime("%B %d, %Y").replace(" 0", " "),
        off=p["state_share"]["off"],
        offloaded=p["state_share"]["offloaded"],
        loaded=p["state_share"]["loaded"],
        run_p50=p["loaded_run_minutes"]["p50"],
        run_p95=p["loaded_run_minutes"]["p95"],
        run_p99=p["loaded_run_minutes"]["p99"],
        cycle_p25=p["cycle_period_minutes"]["p25"],
        cycle_p50=p["cycle_period_minutes"]["p50"],
        cycle_p75=p["cycle_period_minutes"]["p75"],
        duty_p50=p["duty_30min"]["p50"],
        duty_p95=p["duty_30min"]["p95"],
        dv_lo=s["DV_pressure"]["loaded"]["p05"],
        dv_hi=s["DV_pressure"]["loaded"]["p95"],
        tp2_lo=s["TP2"]["loaded"]["p05"],
        tp2_hi=s["TP2"]["loaded"]["p95"],
        res_lo=s["Reservoirs"]["overall"]["p01"],
        res_hi=s["Reservoirs"]["overall"]["p99"],
        oil_p50=s["Oil_temperature"]["overall"]["p50"],
        oil_p95=s["Oil_temperature"]["overall"]["p95"],
        oil_p99=s["Oil_temperature"]["overall"]["p99"],
        cur_lo=s["Motor_current"]["loaded"]["p05"],
        cur_hi=s["Motor_current"]["loaded"]["p95"],
        lps=p["digital_share_on"]["LPS"],
        episodes=p["sustained_load_episodes_excluded"],
        episode_share=p["sustained_load_share_of_time"],
    )


def load_profile() -> dict:
    return json.loads(PROFILE_JSON.read_text())


def main() -> int:
    df = load()
    pre = df.loc[df.index < FIRST_FAILURE_START]
    profile = build_profile(pre)
    PROFILE_JSON.parent.mkdir(parents=True, exist_ok=True)
    PROFILE_JSON.write_text(json.dumps(profile, indent=2) + "\n")
    APU_DOC.parent.mkdir(parents=True, exist_ok=True)
    APU_DOC.write_text(render_apu_doc(profile))
    print(f"wrote {PROFILE_JSON.relative_to(REPO_ROOT)} and {APU_DOC.relative_to(REPO_ROOT)}")
    print(json.dumps({k: profile[k] for k in ("state_share", "loaded_run_minutes", "cycle_period_minutes", "duty_30min", "sustained_load_episodes_excluded")}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
