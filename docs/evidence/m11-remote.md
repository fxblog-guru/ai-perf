# M11 evidence: workers on several machines

Luan asked for ssh and k8s targets "when load really needs to exceed one machine". Until M11 every
worker shared the controller's disk, because the worker protocol is files. M11 keeps that
protocol and carries the files over the network instead.

## Design

```
controller ──opens──▶ channel (HTTP, run token)
   ▲                      ▲
   │ files in run dir     │ GET control · PUT status / hist / errors
   │                      │
   └── same merge ──   perf-agent (each machine) ── local files ── engine worker (unchanged)
```

- **The engines do not know.** Locust, k6, ws and fake workers run on their machine exactly as
  on `local`. The agent mirrors `control.json` down and `status.json`, histogram windows and
  errors up. It pushes status last, so "stopped" never arrives before the windows it covers.
- **Failure is the protocol's.** An agent cut off from the controller stops refreshing
  `control.json`; its worker's heartbeat check stops the worker; the controller sees the status
  go stale and loses it (degraded). The test kills a machine mid-run and gets exactly that.
- **One time axis.** Workers align to the controller's clock through `control.json`, as they
  already did in containers. The agent also measures its machine's skew, so a broken NTP is
  reported.
- **Security.** The channel uses a fresh 32-byte token per run, compared in constant time. It
  accepts only the run's workers and the protocol's files, and refuses anything else (path
  tricks included). The ssh target passes the token on stdin, so it never appears on a command
  line or in `ps`. The k8s target keeps it in a Secret that the Job references. Hosts, paths
  and names are validated as words, so nothing in `ssh.hosts` can be read as an ssh option or a
  second command.

## When to use it

The doctor's generator checks (CPU busy, ports and file descriptors for the planned users) and
the run's `generator_saturated` problem show when one machine is not enough. The
executing-load skill then sends the run to `ssh` or `k8s`. Before the run, `perf doctor --spec`
checks each ssh host: it must be reachable, run the same ai-perf version and have the engine,
and its clock is measured by a timed exchange that leaves out ssh and Node start-up. It also
checks kubectl's rights in the namespace. `perf run` refuses when a host cannot run the agent.

## What was tested, and what was not

`tests/remote.test.mjs` runs the real channel, the real agent and the targets' real commands.
`ssh` and `kubectl` are stand-ins (`mock/fake-ssh.mjs`, `mock/fake-kubectl.mjs`) that run the
"remote" side on this machine:

| Test | Result |
|---|---|
| 2 workers over ssh on 2 hosts | done; about 100 rps; workers spread in turn; no 64-hex token in any command line |
| a host lost mid-run (`flaky…`, agent killed with its children) | the run is degraded; that worker is lost |
| an unreachable host | `perf run` refuses: "cannot run perf-agent: … Connection refused" |
| a host 5 s off | doctor warns "clock +5000 ms (± few ms)"; 0 s is ok |
| 3 workers as pods of an Indexed Job | done; the Job and Secret are deleted at the end; the token is only in the Secret |
| no rights in the namespace | `perf run` refuses |
| channel | wrong token 401; another worker, another file, a path trick 404; bad JSON 400 |
| agent | refuses without a token; `--probe` reports version, clock and engines |

**Not tested here:**

- a real ssh server on another machine;
- a real Kubernetes cluster;
- networks with NAT or a firewall between the workers and the controller (`channel.advertise`
  and a fixed `channel.port` are for those);
- the `docker/agent.Dockerfile` image build.

The first real multi-machine run should be treated as the acceptance test for those.

## The independent review

A reviewer who had not written the code read a snapshot of the change. All findings are fixed;
each fix has a test and a mutant.

| # | Finding | Fix |
|---|---|---|
| 1 | A status PUT with the body `null` crashed the controller (confirmed by a probe) | every body is checked inside a try: non-objects and statuses without `ts`/`state` are 400, a failed write 500 |
| 2 | The controller could kill a local pid or container named by a remote worker's status | the channel drops `child`; the controller never kills or "stops" a remote worker |
| 3 | The agent could push "stopped" before the last window, so the drain ended without it | status read first, windows sent, then that status, only if every window went |
| 4 | `backoffLimit: 0`: one failed pod failed the Job and Kubernetes ended every pod | `backoffLimitPerIndex: 0`, `maxFailedIndexes`: one pod, one lost worker |
| 5 | A lost controller left the Job and Secret; Pending pods never ended | `activeDeadlineSeconds`; `perf doctor --fix` deletes by label; no service-account token in pods |
| 6 | `~/ai-perf` was quoted, so never expanded | a leading `~/` stays outside quotes; other `~` refused |
| 7 | A host could start with `-` | hosts start with a letter or digit, and `--` comes before them |
| 8 | A worker whose ssh failed (no node, a refused key) waited out the barrier | ssh's stderr goes to `agent.log`; its early exit stops the worker at once with the reason |
| 9 | Killing the ssh client was reported as stopping the worker | it is not done; remote workers stop on control |
| 10 | The doctor missed delete rights, the way back to the controller, a missing engine key; probed hosts one by one | all four, hosts in parallel; a short k8s barrier warns |
| 11 | Predictable agent temp folder; skew sign opposite between agent and doctor, and biased by uploads; an advertised port ignored; Dockerfile amd64 only | `mkdtemp` and removal; one sign, GETs only; the advertised port is listened on; `TARGETARCH`, `.dockerignore` |

The reviewer also noted limits of the stand-ins. On Windows, `fake-ssh` runs through cmd.exe,
not sh. Its "flaky" host kills the agent along with ssh. `fake-kubectl` ignores `backoffLimit`,
TTL and Pending pods. These stay untested until the first real multi-machine run.

## Checks

- `tests/remote.test.mjs`: 11 tests, listed above. `npm test`: 273 tests. In the full parallel run one ws test came out not evaluable on the loaded machine: its generator was saturated, which is ai-perf being honest about the machine. It now retries such a run, as the Locust tests already did, and passes 14 of 14.
- Mutation: all 360 mutants killed. That includes 12 for M11, 12 for the M11 review fixes and 6 for the M10 review fixes. The full run first found 7 mutants left stale by moved code; they were retargeted. It also found 2 survivors. The ws kit one is timing-bound and now retries. The other, CPU-is-a-rate, was hidden by a target too young to tell a rate from a total; its test now lets the target run first. Both are killed.
- Independent review: 11 findings, all fixed, above.
