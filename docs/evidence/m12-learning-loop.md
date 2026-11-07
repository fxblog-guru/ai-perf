# M12 evidence: the learning loop

Luan asked for learning that happens on its own: "run code, learn, run, improve", with knowledge
loaded cheaply, kept on the machine, and shared with the team through Recall. Until M12 ai-perf
wrote lessons only when someone ran `/perf-learn`, and it printed them without acting on them.

## Design

```
perf run ──▶ run ──▶ perf report / perf ci ──▶ verdict
   ▲                                   │
   │                                   ▼  (automatic)
   │          learn: lessons.json, learned.json, scorecard.json, brief.md
   │                                   │
   └── learned settings ◀── fix (only the load generator) ──┘
                                       │
                         needs a person (system, plan, environment,
                         no fix that fits, a fix that failed twice)
```

- **Learning is not a step.** `perf report`, `perf ci` and `perf run --until-evaluable` learn from
  every judged run. Nobody has to remember `/perf-learn`.
- **ai-perf fixes what is its own.** A lesson about how the load was made gets a fix in
  `learned.json`:
  - a saturated generator gets more workers;
  - a late engine start gets a longer rampdown;
  - dropped arrivals get a higher VU cap.

  The next run of the same profile, model and target applies the fix. The spec file stays as
  written, and the doctor checks the spec as it will actually run.
- **Every fix is checked.** The first later run that used the fix and ran to its end checks it. It
  is `verified` if the lesson did not come back, and `recurred` if it did, which triggers a larger
  fix.
  - A fix that recurred twice is rolled back and becomes `needs_person`. It stays that way until
    someone runs `perf learn --reset <lesson>`.
  - A run that was stopped, by a person, an auto-stop, the target dying or the deadline, teaches
    nothing and checks nothing.
  - `--until-evaluable` never answers a stop with another run.
- **What ai-perf never fixes.** It never touches the system under test, the planned load, the SLOs
  or the environment.
  - Lessons about the system are the test's findings.
  - Lessons about running the tool that have no safe fix are `needs_person`.
- **Cheap memory.** `perf brief` puts what is known about the project on one page:
  - the system;
  - what was decided and what was measured;
  - the fixes in effect;
  - the lessons for the current step;
  - what the team already knows.

  The page is capped at 60 lines and 6000 characters (about 1500 tokens), whatever the history.
  Every step starts from it instead of from the dozen files behind it.
- **Where things live.**
  - On the project: `.perf/<slug>/` holds `lessons.json`, `learned.json`, `brief.md`,
    `shared.json` and `recalled.json`.
  - On the machine: `~/.ai-perf/` holds tool lessons across projects, scorecards, `shared.json`
    for instance-wide facts, and `proposals/`.
  - In Recall: the team's copy.
- **Sharing.**
  - `perf share` lists every fact Recall does not have yet, in Recall's kinds (`lesson`,
    `defect_pattern`, `decision`, `env_note`), each as the arguments of one `knowledge_push`.
  - A changed fact is listed with `supersedes_id`. Bodies hold only what stays true, so a
    repeated lesson is not pushed again.
  - `--import` takes `knowledge_search` results into the brief.
  - Everything is masked before it is written or shared.
- **Back to the bundle.** A lesson that two projects taught becomes a draft patch to its step's
  skill. The patch is ready for `git apply` and is never applied by ai-perf.

## What was tested

`tests/loop.test.mjs` (15 tests) and `tests/memory.test.mjs` (8 tests) cover the following:

| Case | Result |
|---|---|
| A generator whose CPU grows with its users saturates at 1 worker | attempt 1 NOT EVALUABLE; learned workers 1 → 2; attempt 2 PASS; fix verified by that run; the spec file still says 1; a later plain run starts at 2 |
| Saturated whatever the worker count | fixes recur; after two recurrences `needs_person`, the setting rolled back, the loop stops, at most 3 runs; `--reset` starts the fixes over |
| A run stopped by the target's auto-stop after saturating | "the run was stopped (auto_stop:error_rate): no new attempt"; nothing learned |
| Failed cleanup, HTTP 503 from the target | no fix, one run; cleanup `needs_person`; the 503 is a finding with no remedy |
| `perf report`, `perf ci` | learn on their own; `--no-learned` runs the spec as written and checks no fix |
| Fix limits | this machine's CPUs, 8 per ssh host, 64 on k8s, a closed loop's users; a smoke's VU cap stays ≤ 10; a run from before the lag was recorded teaches nothing |
| A learned VU cap and a closed spec of the same profile; another target | not applied |
| No fix possible now, then the workers lowered | fixed again (a "cannot" is not forever) |
| An open baseline after the VU cap was raised | still compared (users is only the cap) |
| `perf run --no-learned spec.json`; `--until-evaluable --no-learned`; `perf ci --json --until-evaluable` | the spec is the spec; refused; stdout has no progress lines |
| Draft patch | applies with `git apply`; goes under an existing heading that is not last; keeps CRLF; adds a missing final newline; not proposed twice |
| Brief | every section from a judged project; written by `perf report`; `--step` filters; with 200 lessons, 40 environments and 120 team facts: ≤ 60 lines, ≤ 6000 characters, lines clipped, every section still there and saying what it did not show |
| Share | Recall kinds and project label; only confirmed decisions; tool lessons without a project, pushed once per machine; pushed facts not pending; a change supersedes; a repeated lesson not pending; lessons pushed before M12 not pushed again; search order kept; secrets masked both ways |

Existing tests changed in meaning only where learning became automatic:
- `ops.test.mjs` "learn": `perf report` already learned the lesson.
- `ops.test.mjs` "help": after a judged run the next step is the next run, and `/perf-learn` only
  for a run judged before M12.

**Not tested here:**
- a real Recall server: the outbox is checked against the `knowledge_push` and `knowledge_search`
  arguments of Recall's MCP tools, not pushed;
- the doctor's view of a learned spec (ports and files per user, remote hosts), which is checked
  by reading the code only.

## The independent review

A reviewer who had not written the code read the change, reproduced six findings with scripts, and
found 15 in all. All are fixed, and each fix has a test and a mutant.

| # | Finding | Fix |
|---|---|---|
| 1 | `--until-evaluable` started a new run after a person's stop or the target's auto-stop | an `aborted` run ends the loop; it teaches no fix |
| 2 | A VU cap learned by an open run became a closed run's users (four times the load); a smoke learned past 10 users and was then refused forever | settings keyed by profile, model and target; `profile.users` only for open runs; a smoke's cap stays 10 |
| 3 | A raised VU cap made every later open run NOT EVALUABLE against its baseline | open runs compare on the rate, not on users |
| 4 | One "cannot" (an old run, a full machine) blocked the lesson's fixes forever | only a fix that recurred twice is final; an old run without the lag teaches nothing |
| 5 | A fix was "verified" by a run stopped before it could show the problem | only a run that ran its course with a measured window checks a fix |
| 6 | Settings learned on k8s reached a laptop; a fix shown not to help stayed applied; ssh capped at 64; closed loops could get workers with no users | keyed by target; rolled back after two recurrences; 8 per ssh host; at most a closed loop's users |
| 7 | The draft patch went under the wrong heading when the lessons heading was not last; CRLF and missing final newlines not handled | insertion at the end of the heading's section; line ends kept; the final newline handled |
| 8 | Lessons pushed before M12 would be pushed again | a lesson marked pushed counts as shared |
| 9 | Run counts in bodies pushed a successor after every run; tool lessons were pushed once per project | stable bodies; instance-wide facts recorded under `$PERF_HOME` |
| 10 | The brief showed the least relevant results of a search | results kept in the search's order, the first one newest |
| 11 | `perf ci --until-evaluable` judged twice; `--json` stdout not parseable | the loop's judgment is reused; progress goes to stderr with `--json` |
| 12 | `--no-learned` and `--until-evaluable` swallowed the spec path | switches never take a value; the two together are refused |
| 13 | The loop's exit code was undocumented | it is the last verdict's, documented in CONTRACTS and the skill |
| 14 | The skills, README and contract text differed from the code; the doctor checked the spec without learned values | texts aligned; the doctor checks the spec as it will run |
| 15 | Test gaps; the clip assertion was looser than the cap; the first loop test assumed two CPUs | tests added for 1–8 and 12; clip asserted at 160; skipped on one CPU |

## Checks

- `npm test`: 293 tests, all pass (`loop.test.mjs` 15, `memory.test.mjs` 8).
- Mutation: all 410 mutants killed, 50 of them for M12 (29 for the mechanisms, 21 for the review
  fixes). The first M12 run left 4 survivors and 4 stale anchors. Each got a sharper test: the
  attempts bound, a field no fix moves, the brief's masking, the ssh cap per host. The full run
  then found 2 anchors moved by M12; they were retargeted.
- Independent review: 15 findings, all fixed, above.
