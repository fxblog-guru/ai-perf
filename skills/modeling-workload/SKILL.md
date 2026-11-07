---
name: modeling-workload
description: Use to describe what real users do - personas, journeys, mix, think time, open or closed model, and the Little's-law arithmetic (/perf-model).
---

# Modeling the workload

Follow [perf-protocol](../perf-protocol/SKILL.md) and [workload modeling](references/workload-modeling.md).
Write `.perf/<slug>/workload.json`:

```json
{ "model": "closed", "model_reason": "a fixed pool of signed-in shoppers",
  "target": { "users": 200, "source": "measured" },
  "personas": [{ "name": "buyer", "share_pct": 70, "source": "measured" },
               { "name": "browser", "share_pct": 30, "source": "measured" }],
  "journeys": [{ "name": "buy", "persona": "buyer", "weight_pct": 70,
                 "steps": ["login", "listItems", "getItem", "createOrder"], "think_time_s": 3, "source": "measured" },
               { "name": "browse", "persona": "browser", "weight_pct": 30,
                 "steps": ["listItems", "getItem"], "think_time_s": 5, "source": "assumed" }],
  "littles_law": { "rps": 60, "response_s": 0.3, "think_s": 3.0, "users": 200 } }
```

1. When the contract declares traffic classes (`info.x-traffic-classes`), `perf contract` drafts
   the model: a closed loop at each class's concurrency, with Little's law at its peak rate
   (`source: contract`). Mix and think time come from analytics or access logs when you can read
   them (`measured`).
   Otherwise state a plausible mix (`assumed`).
2. Choose open or closed on purpose, and write why. Internet traffic is open: arrivals do not
   wait for the server. Run it with `profile.arrival_rps` on k6 (`users` is then the VU cap). A
   closed loop (Locust, ws) under-samples server stalls, and the verdict warns when its p99 is
   ten times its p95. If the engine cannot do the model the traffic
   needs, say which engine can.
3. Show Little's law: the gate recomputes it and fails when it is off by more than 15 %.
4. Steps are operationIds, so the request names in scripts match (PS-D4).
5. Realtime or game: one virtual user is one player. Persona shares are the player kinds (new,
   regular, heavy). Install and patch download is a separate HTTP/CDN journey; gameplay starts at
   login.
6. A journey's `weight_pct` is its share of virtual users in a closed model, and its share of
   arrivals in an open one. A closed journey with long think time sends fewer requests per user.
   The verdict's mix check accounts for that (CONTRACTS §9), so plan users, not requests.

Gate: `perf check model --slug <slug>`. Its warnings list operations with no SLO. Next: `/perf-env`.
