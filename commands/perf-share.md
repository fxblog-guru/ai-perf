---
description: "Share what ai-perf learned with the team through Recall, and take in what the team already knows."
argument-hint: <slug>
---

Follow the Recall part of `perf-protocol` ("Share with the team") for $ARGUMENTS:
1. Search Recall (`knowledge_search`) for the project label and for "ai-perf"; save the results as
   JSON and run `node <ai-perf>/bin/perf.mjs share --root <project root> --slug <slug> --import <file>`.
2. Run `perf share --slug <slug>`; push each entry with `knowledge_push` as listed; record them with
   `perf share --slug <slug> --pushed <key>=<recall id>,…`.
Without the Recall tools, say so and stop.
