---
created: 2026-09-20
signature: harness:workflow-gate
expires_at: 2026-11-30
---

Workflow-gate: `/approve` only advances when the state file (.pi/workflow.json) has `pendingApproval` set, and that flag is written ONLY by the `workflow` tool with `action=advance` — not by `action=check`. So after writing/validating spec.md, plan.md or tasks.md, run `workflow action=advance` (it re-validates and prints "Marked awaiting approval"), then the human types /approve. Symptom if you skip it: "workflow-gate: nothing awaiting approval (phase=...)" even though `action=check` said "VALID ... Ready for /approve".
