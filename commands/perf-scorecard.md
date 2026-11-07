---
description: Runs it took before a run could be judged, per ai-perf version and profile, and why the earlier ones could not.
argument-hint: <slug> | --global
---

Run `node <ai-perf>/bin/perf.mjs scorecard --root <project root> --slug $ARGUMENTS` and show it. Name the
most frequent reason a run could not be judged and the step that fixes it. With `--global`, compare
versions: a median that grows is a regression of the bundle.
