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

Measured on 62.9 days of logged data before April 18, 2020, leaving out 10
unreported episodes in which the compressor stayed under load for more than 20
minutes without a break (3.5% of the logged time before that
date). In normal operation the compressor was off 65% of the logged time,
running offloaded 26% and under load 9%. A normal loaded
run lasted 1.8 minutes at the median; 95% of runs were shorter than
2.8 minutes and 99% shorter than 5.5 minutes. The time from
one load start to the next was 24 minutes at the median (middle
half: 15 to 31 minutes). Over any half hour the
compressor was under load 7% of the time at the median and
18% at the 95th percentile. While the compressor was under load, DV
pressure stayed between -0.03 and 0.24 bar (5th to 95th
percentile) and TP2 between 5.5 and 10.4 bar. Reservoir
pressure stayed between 8.1 and 10.1 bar (1st to 99th
percentile). Oil temperature was 58 degrees Celsius at the median,
69 at the 95th percentile and 72 at the 99th. Motor
current under load was 5.2 to 6.2 A. The low pressure switch
(LPS) was active 0.10% of the time.
