# Workload modeling

## Little's law

`users = throughput × (response time + think time)`. A closed model of 20 users that each wait
0.1 s between requests, against 25 ms responses, gives at most 20 / 0.125 = 160 rps.
`workload.json` `littles_law` shows this arithmetic, and the model gate checks it holds within
15 %.

## Open or closed (PS-B5)

| Model | Load is set by | Use for | Risk |
|---|---|---|---|
| Closed | a fixed number of users, each waiting for its response | fixed pools: staff apps, call centres, game sessions | **coordinated omission**: when the system slows, users send less, and the slowdown hides itself |
| Open | an arrival rate, independent of responses | internet traffic, APIs, capacity tests | a slow system builds a queue; that is the truth |

Locust is closed. Gatling and k6 do both. For open internet traffic at high rate, say so, and
prefer an open-model engine.

## Personas and journeys

- A **persona** is a kind of user (buyer, browser, admin; in a game: new player, regular, heavy
  player), with a share of the population.
- A **journey** is a chained business flow, with ids and tokens extracted and reused (PS-B2). It
  is never a single endpoint hammered in isolation.
- Weights come from analytics or logs (`source: measured`). Without them, use a plausible mix
  (`assumed`) and name it in the verdict.
- In a game, a character is data: level, inventory and region live in the data pool, and every
  engine reads the same pool.

## From a peak to a profile

| Profile | Question it answers |
|---|---|
| smoke | does the wiring work? (1–5 users, errors only) |
| baseline | how fast is it with nobody else on it? |
| load | does it meet the SLO at the expected peak? |
| stress | where does it break (the knee)? A staircase (`steps`, `step_s`) gives the capacity |
| breakpoint | how far past the peak can it go? A staircase with a ceiling (`breakpoint: { factor, max }`) run with `perf run --breakpoint`: it climbs on until a step breaks |
| spike | does it survive a sudden jump, and recover? (`spike`, judged on recovery time) |
| soak | does it degrade over hours (leaks, pools, disks)? Judged on p95 and memory drift |
| capacity | how many users at the SLA, and what headroom? |
| recovery | after an overload, does it come back by itself? An overload (`spike` shape) and the normal load again; judged on the time back within the SLO (`recovery.recovery_s`) |
| volume | is it still fast with production-sized data? A load on data seeded to the volume plan (`data/manifest.json` `volume`); at volume only when the counts before the run reach it |
| scalability | does a second instance double the throughput? Not a profile: the stress staircase per instance count, `perf scale`; judged on the scaling efficiency |
