---
name: preparing-perf-data
description: Use to prepare test data - accounts or characters per virtual user, run-id-prefixed writes, and the cleanup after every run (/perf-data).
---

# Preparing test data

Follow [perf-protocol](../perf-protocol/SKILL.md). Write `.perf/<slug>/data/manifest.json`:

```json
{ "accounts": { "count": 200, "source": "file", "env_var": "PERF_ACCOUNTS_CSV" },
  "cleanup": { "command": "node scripts/cleanup.mjs --prefix $RUN_ID" },
  "run_id_prefix": true }
```

1. **One account per concurrent user.** A thousand users on one account measure the cache, not
   the system. If sharing is real (a kiosk app), set `accounts.shared_reason`.
2. **Credentials never in the repo.** They come from a file named by an environment variable, or
   a CI file variable. `perf doctor` scans `.perf/` and the run folders for credentials.
3. **Writes carry the run id**, so cleanup is one query by prefix (PS-B6).
4. **Each worker gets its own partition.** Every worker is started with `AI_PERF_WORKER` (its
   index) and `AI_PERF_WORKERS` (the count). The script takes the accounts where index mod
   AI_PERF_WORKERS = AI_PERF_WORKER, as `mock/locustfile.py` does.
5. **Characters** (games): level, inventory and region are columns of the same data pool.
6. Write the cleanup script, run it once by hand, and show that it removes what a smoke wrote.
   From then on the controller runs it after every run with the run id; a failed or hung cleanup
   is a WARN in the verdict. A target that keeps no data says so: `"command": "none: <why>"`.

7. **Volume** (when the plan has a `volume` profile, or the system is multi-tenant, batch or
   reporting: see `/perf-plan`). Enough accounts for the load is not a database of production
   size. Add a volume plan to the manifest:

   ```json
   "volume": {
     "entities": {
       "orders":  { "target": 5000000, "source": "measured",
                    "seed": "node scripts/seed.mjs {entity} {target}",
                    "count": "node scripts/count.mjs {entity}" },
       "tenants": { "target": 1200, "source": "confirmed",
                    "seed": "node scripts/seed.mjs {entity} {target}",
                    "count": "docker exec shop-db psql -U perf -tAc \"select count(*) from tenants\"" } },
     "min_pct": 95 }
   ```

   - `target` is the row count production has (or will have), with its `source` like any number:
     `measured` from production's own count, `confirmed` by its owner.
   - `count` prints the rows that are there now (its last line, a whole number). `seed` loads
     them; ai-perf never generates rows. Seed with the database's bulk tools (COPY, a restore of
     a masked production dump), not through the API: five million orders through HTTP take days.
   - Both run from the project root **without a shell**. `{entity}` and `{target}` are filled in;
     pipes, `&&` or redirects go in a script the command calls.
   - Run `perf volume --slug <slug> --seed`, then `perf volume --slug <slug>`: it must say
     AT VOLUME. From then on every run but a smoke counts again just before it starts, and keeps
     the counts. A `volume` run short of `min_pct` of any target is NOT EVALUABLE; any other run is
     a WARN. Runs at volumes more than 5 % apart are not compared (STALE).
   - Cleanup removes what a run wrote (by its run id), never the seeded volume.

Gate: `perf check data --slug <slug>`. Next: `/perf-script`.
