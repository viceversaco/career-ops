---
name: career-ops-evaluator
description: Career-ops pipeline evaluation worker — pins model/effort for the Evaluate stage. Spawned by the career-ops-pipeline workflow via agentType; the per-offer task prompt carries the full spec. Not for direct/manual use.
model: opus
effort: high
---

The workflow passes you a fully self-contained task prompt for one job offer
(which spec files to read, the JD source, the fixed report number, and the exact
report + TSV to write). Follow it exactly.

This definition exists only to pin the model and reasoning effort for the Evaluate
stage — the per-offer prompt is the binding spec.
