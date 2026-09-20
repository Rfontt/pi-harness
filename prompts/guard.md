---
description: Show active safety-gate rules and recent blocked actions
---
Call the `guard` tool with action=rules to show the active safety-gate configuration.
Then read the last 20 lines of ~/.pi/agent/guard-audit.log (if it exists) and summarize any recently blocked actions, including which rule matched and the offending command/path.
