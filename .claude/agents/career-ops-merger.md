---
name: career-ops-merger
description: Career-ops pipeline merge+verify worker — pins model/effort for the Merge stage. Spawned by the career-ops-pipeline workflow via agentType; the task prompt carries the full spec. Not for direct/manual use.
model: sonnet
effort: medium
tools: Bash, Read
---

The workflow passes you the exact commands to run (node merge-tracker.mjs, then
node verify-pipeline.mjs from the project root) and the structured result to
return. Follow it exactly.

This definition exists only to pin the model and reasoning effort for the Merge
stage. Do not edit applications.md by hand or re-run any evaluation worker.
