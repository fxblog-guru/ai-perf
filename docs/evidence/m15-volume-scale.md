# M15 evidence: volume and scalability

[`docs/coverage.md`](../coverage.md) §1 had two rows marked missing. Volume: `/perf-data` made
enough accounts for the load, not a database of production size, and nothing checked the size
actually loaded. Scalability: a capacity per instance count meant one staircase per count and
`perf compare` by hand, with no efficiency figure. M15 closes both. Each mechanism has a check
that fails when the mechanism is broken (design §13).

## Design

```
data/manifest.json volume                         perf scale scale.json --instances 1,2,4
  entities: { orders: { target, seed, count } }     for each count n:
perf volume --seed ─▶ seed ─▶ count ─▶ volume.md      command {n} (no shell) ─▶ wait for ready (< 500)
perf run (not smoke) ─▶ count ─▶ run.volume            run the staircase × n/base ─▶ judge ─▶ analysis
verdict: volume run short ─▶ NOT EVALUABLE             read: broke / held / generator / unjudged
         other run short  ─▶ WARN                     efficiency = held(n) / (n/base × held(base))
         at volume        ─▶ note + summary            linear ≥ 0.8 · flat ≤ +10 % · sublinear
compareBaseline: counts > 5 % apart ─▶ STALE (data)    flat/sublinear: bottleneck named by a signal
                 other instances    ─▶ refused        scale-<name>.md / .json
```

**Commands without a shell** (`lib/command.mjs`). The seed, count and scale commands are the
project's. They are split into words (quotes keep spaces, backslashes stay), each placeholder
(`{n}`, `{entity}`, `{target}`) is filled inside its own word, and the program is started with
those words as its arguments. Nothing in a template or a value reaches a shell: `;`, `&&`, `|`
and `$(...)` are plain arguments. An instance count must be 1 to 4 digits before it is ever
substituted, so `1;id`, `2.5` and `0x10` are refused at the plan check. The price: a pipe or a
redirect belongs in a script the command calls; the skills say so.

**Volume** (`lib/volume.mjs`).
- The plan lives in the data manifest, so the data gate (`perf check data`) checks it: at least
  one entity, a whole-number `target` with its `source` (P3), a `count` command, an optional
  `seed`, `min_pct` in (0, 100] (default 95), no unknown key.
- `perf volume --slug s [--seed]` seeds only when asked, then counts. A count is the last
  non-empty line a command printed, a whole number with or without separators; a command that
  failed counted nothing, even if it printed a number.
- `perf run` counts again just before every run but a smoke and records the counts in `run.json`
  and `result.run.volume`. The verdict reads that count, never a seed or an earlier count: a run
  is at volume only when every entity counted at least `min_pct` % of its target.
- A `volume` profile is refused without a plan. Short or uncounted data: NOT EVALUABLE on a
  `volume` run (it says nothing about production-sized data), a WARN on any other profile (its
  numbers flatter the target). The summary says on which data the run was measured.
- Comparison: the plan's targets join the data fingerprint (a manifest without a plan keeps the
  digest it had, so no existing baseline turns STALE). The counts are compared apart with a
  tolerance: more than 5 % apart, or counted in one run and not the other, is STALE (`data`).
  `compareBaseline` is the one place this lives, so the baseline, `perf compare`, `perf trend`
  and `perf matrix` all follow it (a matrix variant that declares `changes: ["data"]` is
  exempt, as for the fingerprint).

**Scalability** (`lib/scale.mjs`, the loop in `bin/perf.mjs`).
- A plan file (`spec`, `instances`, `command`, `steps`, `ready`, `timeout_s`) or a run spec with
  `--instances` and `--command`. The spec must be a staircase.
- Per count: the command (non-zero exit: the count is not run), then the wait until the
  target, or `ready.url` on the same host, answers below 500 (a 503 while instances start is not
  ready), then an ordinary run with its own folder and verdict, `instances` recorded.
- By default each count climbs the spec's steps times n / base, so every count is read on the
  same grid relative to what it should carry, and the efficiency compares like with like.
- Each run is read with the breakpoint's reading (M14). The capacity is the highest step that
  held. When the generator saturated, only the steps that ended before the first saturation
  count.
- Per count after the base: `linear` (efficiency ≥ 0.8), `flat` (at most 10 % over the last
  count before it with a capacity; less is said as negative), `sublinear`, `generator` (the
  generator is the limit, the target held at least X), `unknown` (only a floor was observed, or
  no base capacity), `not_measured`. A flat or sublinear count names its shared bottleneck from
  the run's analysis when a signal was the cause at the knee (M13), and otherwise says no signal
  named it.
- Runs at other instance counts are refused as a baseline or a compare pair: another
  deployment.

**The mock deployment** (`mock/scale-lb.mjs`). A balancer in front of N backend servers. `scale
<n>` deploys n (returns at once; new instances answer after `--start-ms`, and the balancer answers
503 until they do). Each backend reports its capacity; `/lb/capacity` sums what the ready ones
report and caps it at `--shared` (a database all instances share). `/metrics` gives
`db_pool_used_pct`: served / shared. The fake engine's `capacity_url` asks it before the worker is
ready and tells it every tick what the worker offers. So the end-to-end tests run real
processes: a real scale command, a real readiness wait, a capacity read from the deployment, a
signal scraped from it.

## What each check proves

`tests/scale.test.mjs`, 14 tests:

| Case | Proves |
|---|---|
| command without a shell | words and quotes, an unclosed quote refused, `{n}` filled in its word; a template with `; echo pwned > pwned.txt && $(whoami) \| more` passes all of it as arguments and creates no file; a missing program and an exit code are reported |
| volume plan checked | every rule of the plan, through the data gate; counts parsed with separators, decimals and words refused |
| perf volume | counting never seeds; `--seed` seeds then counts; a count command that printed 12 and failed counted nothing; 94 % is short at 95 and at volume at 90; exit 0, 3, and 2 without a plan |
| counted before the run | a smoke counts nothing; a volume run at full counts PASSes with the note and summary, `counted_at` before `started_at`; at 90 % it is NOT EVALUABLE; a load run on the same data is a WARN; a volume run without a plan is refused (exit 2) |
| nothing counted | a judged volume run with no count is NOT EVALUABLE; a load run without a plan is not judged on volume |
| STALE across volumes | 4 % apart is the same data, 10 % apart or uncounted is STALE with the numbers; another instance count is refused; the plan's targets change the data digest and no plan keeps the old one; a matrix variant is STALE for its counts unless it declares the data change |
| baseline at another volume | end to end: a baseline at 5,000,000 orders, a run at 4,000,000 is NOT EVALUABLE (STALE, `data`), and `perf compare` refuses the pair (exit 3) |
| scale plan checked | instance counts: `1;rm -rf /`, `2.5`, `0x10`, `$(id)`, 0, descending, repeated, one, nine all refused; every plan rule; the scaled grid |
| efficiency and verdict | linear, sublinear (unnamed bottleneck), flat (the pool named), negative, 0.8 exactly linear; held → linear "at least" or unknown; generator; no base capacity (held, broke at first step, not measured) |
| reading a count | a held staircase; a saturated generator keeps only the steps that ended before it |
| ready | a 503 is not ready after the timeout; a 401 is ready; nothing listening is not ready |
| linear then flat (end to end) | 1, 2, 4 instances of 100 rps sharing a 250 rps pool: 16, 32, 32 users; efficiency 1 then 0.5; flat at 4, named "waiting on db_pool: a connection pool was full"; each count waited about 3 s for its instances; each run records its count; the two counts are not compared |
| generator (end to end) | at 4 instances the generator saturates at 128 users: the verdict is `generator`, the target held at least 64, nothing called sublinear or flat |
| refusals (end to end) | a failing scale command runs nothing (exit 3, the reason in the report); a probe off the target host, a non-numeric count and a spec with no staircase are refused (exit 2) |

## Results

RESULTS

## What is NOT tested

- **No real cluster, no real database.** The scale tests run a mock balancer and the fake engine,
  which asks the balancer what it serves; `docker compose --scale` and Kubernetes are not run.
  The volume tests count with a script, not `SELECT COUNT(*)` on millions of rows: a count of a
  large table can take seconds, and it runs before every run.
- **Quantised capacity.** The capacity of a count is its highest held step; with `steps:
  scaled` every count is read on the same relative grid, so the efficiency compares like with
  like, but a coarse staircase (factor 2) can only say 1, 0.5 or 0.25. The report gives the steps;
  finer steps give a finer answer. Repeated runs per count are not built.
- **Readiness** is an HTTP answer below 500 from one URL. A deployment that answers before all
  its instances serve (a balancer that routes to the old ones) is read too early; `ready.url`
  should be a path that only answers when the new count is serving.
- **The shell-free commands** cannot pipe. A Windows `.cmd` (npm, some CLIs) cannot be started
  without a shell either; it needs `cmd /c` in the template or a script.
- **Cleanup after scaling.** ai-perf leaves the deployment at the last count; scaling back is the
  project's.
- **Volume while a run writes.** Only the count before the run is judged. A run that deletes or
  grows data during the load is not counted again after it.
