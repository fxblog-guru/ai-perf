# M6 evidence: dogfood on fx-blog

ai-perf ran its whole lifecycle on fx-blog, the way a new user would. It did so on 2026-10-30, on
Windows 11, sharing the laptop with heavy video renders from another session.

## Setup, and what was not touched

- **Target:** fx-blog's production build (`dist/server-entry.js`, Next.js), from its working tree,
  read only.
- **Database:** a separate Postgres 17 container on 127.0.0.1:5440, migrated, with fx-blog's G8
  volume seed (300 posts, 30,000 comments, 5,000 readers, 60,000 ratings) and its base seed.
- **Not touched:**
  - the other session's database (`fxblog-lane5-db-1`);
  - fx-blog's working tree: `git status` was unchanged before and after;
  - its branch.
- **Not done:** nothing was deployed, pushed or merged.
- **Workspace:** ai-perf worked in a scratch copy of the sources (no `node_modules`, `.next`,
  `dist` or `.git`). Its `.perf/` therefore never landed in fx-blog.
- **Cleanup:** the app and the database container were removed at the end.

## The lifecycle, step by step

| Step | What ai-perf did | Right? |
|---|---|---|
| doctor | engines: fake, k6 (Docker), ws. Locust was found only through `PERF_PYTHON` | right |
| discover | found the contract (`.sdlc/api/anime-blog/openapi.yaml`: 170 operations, 176 `x-perf` budgets), Next.js, Postgres and the sdlc contract. It did not ask for the peak load, because the contract holds it | right |
| discover | "Existing perf suites: none", although fx-blog has `tests/perf/load.mjs`, `scripts/perf-check.mjs` and `.sdlc/scripts/perf-smoke.mjs` | **wrong, fixed** (finding 1) |
| discover | asked "which kind of system?" although the contract's traffic classes answer it | **wrong, fixed** (finding 2) |
| plan, model | no way to use the 176 budgets: the AI would have typed them by hand | **gap, fixed** (finding 3) |
| contract (new) | `perf contract --ops listPosts,getPost,listPostComments,searchContent`: SLA = budget (300/300/300/500 ms), SLO 20 % stricter, 10 read and 10 search clients in a closed loop | right, once fixed: its first draft failed the model gate (journey weights summed to 200, no Little's law), and **the gate caught the bug in ai-perf's own draft** |
| env, data | `env.json`: 127.0.0.1 only, parity named, SMTP, AI and S3 stubbed, Postgres monitored. Data: public reads need no accounts | right |
| script | a Locust script from the workload: operationIds as names, a business check per request, its own `X-Forwarded-For` per user (fx-blog limits per address). k6 under Docker could not reach a server bound to the host's loopback | right |
| smoke | done; the script gate passed (every operation ran) | right |
| load, first try | auto-stopped in ramp: "target CPU 118.67 % > 95", verdict FAIL "the target failed under load" | **wrong, fixed** (finding 4): `docker stats` counts per core, and Postgres was using 1.2 of 16 cores |
| load | 20 clients, 60 s steady: 127.8 rps, 0 errors, p95 216–281 ms. WARN: `getPost` and `listPostComments` were over their SLO (240), within their SLA (300) | right |
| analyze | "target waiting, not computing: CPU low": only the database was monitored, and the app server runs on the host | **overclaimed, fixed** (finding 5) |
| parity | the same scenario as fx-blog's own `load.mjs` (`listPosts` alone, 10 clients, closed, 30 s): ai-perf **p95 77.0 ms**, fx-blog's script **76.4 ms** | right: the percentiles agree within 1 % (throughput differs, 215 vs 173 rps: two HTTP clients) |
| promote, second run, compare | the same build was **22 % faster** on every operation in the second run | the comparison was right, but nothing said that a 22 % swing on one build is the machine's noise: **fixed** (finding 6) |
| learn | one lesson from the bottleneck, with its evidence | right |
| ci | `perf ci` smoke: exit 0 PASS, JUnit written | right |

## Findings, and what changed in ai-perf

1. **In-house load scripts were invisible.** Discover knew Locust, k6, JMeter and Gatling only.
   - **Now:** a script in a `perf`/`load`/`stress`/`bench` folder, or named so, that sends
     requests, is listed as an `in-house` suite.
   - Import says what to do with it: keep it, take its operations from the contract, and run a
     parity check.
   - The audit skips it.
   - Test: `discover: an in-house load script is found…` (mutant `discover: in-house suites seen`).
2. **The system kind was asked although the contract answers it.**
   - **Now:** if the GET classes carry 80 % or more of the contract's peak rate, the system is
     read-heavy; otherwise it is transactional.
   - The answer is recorded with source `contract`, and the question is not asked.
   - Test: `discover: the contract says how the system is used…`.
3. **Budgets in a contract could not be used.** **Now:** `perf contract` (design D14) reads OpenAPI
   YAML without a parser and drafts `slo.json` and `workload.json`.
   - The verdict names the error-rate limits that are defaults (the contract gives none).
   - Tests: `tests/contract.test.mjs` (five mutants).
4. **Target CPU was per core.** `docker stats` reports CPU as a percentage of one core.
   - **Now:** `target_cpu_pct` is the share of the CPUs the container may use: its limit, else the
     Docker host's CPUs.
   - Before this fix, any multi-core database under real load tripped the auto-stop and got a
     FAIL. This was the most harmful defect found, and no test had caught it, because every test
     used a stand-in docker.
   - Test: `docker-stats: CPU is the share…` (mutant `docker-stats: share of the CPUs`).
5. **The bottleneck hint overclaimed.**
   - **Now:** it names the containers it watched ("not CPU in aiperf-dogfood-db"), and lists the
     unmonitored parts (the app server) among the places the wait could be.
   - The exam was changed to require both.
6. **Run-to-run noise was not named.** The same build moved 22 % between two runs on this
   laptop, more than the 10 % regression gate.
   - **Now:** when the baseline is the same build (git sha) under the same fingerprint, the verdict
     and `perf compare` say that the difference is the environment's noise. The FAIL stays: the
     gate is not weakened.
   - Test: `same build, same fingerprint…` (two mutants).
7. **Monitoring sees containers only.** fx-blog's app runs on the host, so its CPU was never seen.
   This is not fixed in M6: a host-process metrics adapter is listed for later. The analysis now
   says so instead of guessing (finding 5).

## What the AI (the skills) got right without help

- It ran smoke before load, and smoke judged wiring only.
- It kept every number's source: contract, default, confirmed.
- It refused to compare unlike runs: the parity run (10 users) was never compared with the
  20-user load runs.
- It picked Locust over k6 for a reason that can be checked: a loopback-bound server cannot be
  reached from Docker.
- It never wrote into fx-blog and never used the other session's database.

## Numbers (for the record)

| Run | Profile | Clients | rps | p95 listPosts | p95 getPost | p95 listPostComments | p95 searchContent | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 (after the CPU fix) | load | 20 mixed | 127.8 | 216.8 | 261.9 | 259.4 | 280.8 | WARN (SLO) |
| 2, same build | load | 20 mixed | 159.2 | 177.7 | 204.3 | 196.3 | 216.8 | PASS against run 1; −18 to −24 % from noise |
| parity | load | 10, listPosts only | 215.0 | 77.0 | — | — | — | — |
| fx-blog `load.mjs` | its own | 10 per operation | 173.1 | 76.4 | 92.7 | 76.6 | 132.5 | its verdict: all ok |

## Independent review of M6

An independent reviewer, given the paths and the design, reproduced findings 1–5 with scratch
fixtures and found 6–7 by reading the code. It confirmed seven. All seven are fixed. Each fix has a
test, and each test has at least one mutant it kills.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | high | The YAML reader filed a response link's or a webhook's `operationId` and `x-perf` under the last operation, and the wrong `slo.json` passed the gate | It reads operations under `paths` only, and each one's own keys at its child indent only. It refuses a second `operationId` and any `x-perf` it cannot place (callbacks excepted) |
| 2 | medium-high | Writes without an `operationId` were dropped, so a write-heavy class could read as read-heavy | Every operation counts for the system kind; only drafting needs an id |
| 3 | medium | Flow-form classes, block `x-perf`, inline comments and quoted paths were misread silently | All four are read. A budget that is not a number of milliseconds is refused |
| 4 | medium | `src/loaders/`, `loadConfig.js` and `bench-*.mjs` counted as in-house suites | Folders are matched by exact name, and a script needs a load shape: a loop or concurrency with a request |
| 5 | medium | Little's law held by construction; an overdrive (100 clients against a 10 rps peak) went unseen | The draft records the rate the loop drives at the budget beside `peak_rps`, warns above 3×, and gives a rate-only class the clients and think time its peak needs |
| 6 | medium | CPU set by quota or cpuset was ignored, a failed `inspect` was cached, and a pegged single-threaded target read as "not CPU" | Quota and cpuset are read, a failed `inspect` is retried, and `target_cpu_cores` is kept: the analysis says "maybe CPU-bound on one thread" |
| 7 | low-medium | Uncommitted changes at the same sha counted as "the same build" | `git_dirty` is recorded: only two clean runs at one sha are the same build |

The reader was checked again against fx-blog's real contract after the fixes: 170 operations, 170
budgets, 12 classes. It warned that the `search` class drives 5× its peak. For fx-blog that is
intended, because its DEC-016 treats the peak as a floor, but it is now said.

## Final run

- `npm test`: 197 tests, 197 pass, 0 fail (Windows 11, Node 24; Locust, k6, ws and Docker tests ran, none skipped).
- `npm run mutate`: 205 mutants, all killed. In the full run, 204 were killed and one reported
  `STALE`: its line had changed when in-house suites were exempted from the import gate. Repointed
  to the new line, it is killed.
