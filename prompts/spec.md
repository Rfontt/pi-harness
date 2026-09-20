---
description: Write the right planning artifact before code; for new features, drive the spec→plan→tasks workflow gate
---
Use the spec-driven-development skill. Pick the artifact by situation: PR/FAQ (product idea), design doc (change to existing system), or spec→plan→tasks (new feature). For a new feature, first call the `workflow` tool (action=start with a slug), then write spec.md (WHAT) with the exact template, mark every ambiguity [NEEDS CLARIFICATION], never guess. Run `workflow action=check` until valid, then ask the user to type /approve. Do NOT write plan.md or tasks.md before spec is approved — the gate blocks it in code.
