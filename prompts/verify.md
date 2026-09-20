---
description: Actually verify (run tests/checks) before claiming success
---
If a workflow is active (phase=implement), call the workflow tool with action=verify — it runs the project's verify commands and static rules from gates.json and reports pass/fail for real. Fix failures and re-run until clean. If no workflow is active, run the project's tests and checks for real and report the actual result (pass/fail, with output). Never claim something passed without running it. If it fails, use the debugging skill.
