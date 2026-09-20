---
name: spec-driven-development
description: Produce production-grade planning artifacts — PR/FAQ, design doc, or spec → plan → tasks — with the exact templates senior engineers at Amazon, Google, and GitHub use. Use for new features, subsystems, architecture/data-model/contract changes, product ideas, or when the user asks for a spec. For small well-scoped edits use the lightweight `planning` skill instead.
---

# Spec-Driven Development — the senior-engineer playbook

One rule above all: **write it down before you build it, and get it approved before you code.** This skill is the concrete templates, not the theory. Copy the section below that matches your situation, fill it in, and stop at the approval gate.

## Which document when

| Situation | Document | Length | Origin |
|---|---|---|---|
| "Should we build this?" — product idea, value unclear | **PR/FAQ** | 1 page | Amazon (Working Backwards) |
| Significant change to an existing system | **Design Doc** | 1–3 pages | Google |
| New feature / greenfield build (with an agent) | **spec.md → plan.md → tasks.md** | 3 files | GitHub Spec Kit |
| Project non-negotiables, set once | **Constitution** | 1 page | Spec Kit |

---

## 1. PR/FAQ — Amazon Working Backwards

Write the **press release FIRST**, as if the product already launched. If you can't write a compelling one, the idea isn't ready — stop.

**Press Release (1 page):**
```
Headline:        Introducing [product] — [single most important benefit]
Sub-headline:    for [customer], who [pain point]
Summary:         what it is + why now (2–3 sentences)
Problem:         the pain, in the customer's words
Solution:        how it works + the one benefit that matters most
Customer quote:  one sentence from a (hypothetical) real user
Call to action:  "Getting started is as simple as [concrete step]"
```

**The 5 questions the PR must answer:**
1. Who is the customer?
2. What is the customer's problem or opportunity?
3. What is the single most important customer benefit?
4. How do you know what customers need or want?
5. What does the customer experience look like?

**FAQ — two lists:**
- **External** (customer would ask): price, limits, availability, "can it do X?".
- **Internal** (the hard ones): cost/revenue, dependencies, technical risk, what we gave up, why now.

---

## 2. Design Doc — Google

Short, written to drive a *decision*, reviewed before any code. Non-goals and alternatives are as important as the design itself.

```
# [Title]
## Context        — the problem, why now, with data/incident/issue links
## Goals          — numbered; what this design MUST achieve
## Non-Goals      — explicitly out of scope (prevents scope creep)
## Design         — overview, key components, data flow, API sketch
## Alternatives   — for each option: trade-off + why rejected (≥1 per decision)
## Cross-cutting  — security, privacy, observability, migration/compat
## Open Questions — unresolved items that don't block the decision
```

---

## 3. spec.md — WHAT and WHY (no tech stack, no code structure)

Each user story is an **independently shippable slice** — build just P1 and you still have a working MVP.

```markdown
# Feature Spec: [name]
Status: Draft | Branch: [###-slug] | Input: "[user's description]"

## User Stories (prioritized, each independently testable)
### US1 — [title] (P1 · MVP)
[plain-language journey]
Why this priority: [value delivered]
Independent test: [how to verify this story alone, e.g. "sign up and see a dashboard"]
Acceptance:
- Given [state], When [action], Then [outcome]
- Given [state], When [action], Then [outcome]

### US2 — [title] (P2)
...

## Edge Cases
- What happens when [boundary condition]?
- How does the system handle [error scenario]?

## Functional Requirements
- FR-001: System MUST [capability]
- FR-002: System MUST authenticate via [NEEDS CLARIFICATION: email/password, SSO, or OAuth?]

## Key Entities (only if data is involved)
- [Entity]: [what it represents + key attributes + relations, no implementation]

## Success Criteria (measurable, technology-agnostic)
- SC-001: [metric, e.g. "user completes signup in under 2 minutes"]
- SC-002: [metric, e.g. "handles 1000 concurrent users without degradation"]

## Assumptions
- [scope boundary / reasonable default / existing-system dependency]
```

---

## 4. plan.md — HOW (architecture, with rationale and gates)

```markdown
# Plan: [feature]
Spec: [link to spec.md] | Branch: [###-slug]

## Summary — [primary requirement + chosen technical approach]

## Technical Context
Language/Version: [e.g. Python 3.11 | NEEDS CLARIFICATION]
Dependencies:     [e.g. FastAPI | NEEDS CLARIFICATION]
Storage:          [e.g. PostgreSQL | N/A]
Testing:          [e.g. pytest]
Target Platform:  [e.g. Linux server]
Project Type:     [library | cli | web-service | mobile | ...]
Perf Goals:       [e.g. 1000 req/s]
Constraints:      [e.g. <200ms p95, offline-capable]
Scale/Scope:      [e.g. 10k users, 50 screens]

## Constitution Check — GATE (pass before research; re-check after design)
- [ ] Simplicity: fewest moving parts that satisfy the spec (no future-proofing)
- [ ] Test-first: contracts/tests defined before implementation
- [ ] No speculative or "might need" features

## Structure — [source layout, matching the project type]

## Complexity Tracking (fill ONLY if a gate is violated)
| Violation | Why needed | Simpler alternative rejected because |
```

---

## 5. tasks.md — EXECUTE (diff-ready, for the implement agent)

tasks.md is written for the AGENT that implements — make it mechanical, not interpretive. Each task is ONE surgical edit, self-contained: exact file, exact OLD/NEW snippets, the exact test, and an objective "done" criterion. The implement agent applies it with `edit(oldText, newText)` and never re-reads spec.md/plan.md.

````markdown
# Tasks: [feature]

## T001 — [short title]
File: src/domain/PaymentService.kt
Test: src/test/kotlin/domain/PaymentServiceTest.kt :: shouldRefundIdempotently
Done: `./gradlew test --tests PaymentServiceTest` green; no other file touched

OLD:
```kotlin
    fun refund(amount: Money) {
        balance += amount
        transactions.add(Refund(amount))
    }
```

NEW:
```kotlin
    fun refund(amount: Money, requestId: String) {
        if (transactions.any { it.requestId == requestId }) return
        balance += amount
        transactions.add(Refund(amount, requestId))
    }
```

## T002 — [short title]
File: ...
````

**Rules:**
- OLD must be copied VERBATIM from the current file (never paraphrased). NEW is the exact replacement.
- One task = one file = one focused change. Split anything bigger into more tasks.
- Every task names the exact test that validates it (file + test name) and an objective Done.
- Order tasks by dependency; implement runs them strictly in order, verifying each Done.
- If a task needs a file the plan didn't mention, STOP and go back to plan — never improvise.

---

## 6. Constitution — set once per project

```markdown
# [Project] Constitution
## Core Principles
I.   [name] — [rule, e.g. "Test-First: tests written → approved → fail → then implement"]
II.  [name] — [rule, e.g. "Simplicity: start minimal, YAGNI"]
III. [name] — [rule]
## Governance — this supersedes other practices; amendments need documented rationale + approval
Version: [x.y.z] | Ratified: [date] | Last Amended: [date]
```

---

## How to run it (with the workflow gate)

The `workflow` tool + `/approve` gate the spec → plan → tasks → implement → review chain in CODE: spec, plan and tasks are read-only over source until `implement`; the `implement → review` transition is gated by VERIFY (gates.json commands + rules) — the model cannot declare "tests passed".

1. **Explore** — read `.ai/`, relevant code, and tests before writing anything.
2. **Start** — call the `workflow` tool with `action=start` and a slug. This opens phase=spec.
3. **Specify** — write `spec.md` (WHAT). Mark every ambiguity `[NEEDS CLARIFICATION]`. Never guess. Run `workflow action=check` until valid, then the human types `/approve`.
4. **Plan** — write `plan.md` (HOW) with goals/non-goals, alternatives, and the constitution check. Read the actual files and capture VERBATIM snippets for the upcoming tasks. `/approve` when done.
5. **Task** — derive `tasks.md` in the diff-ready format (File + OLD/NEW verbatim + Test + Done). `/approve` when done.
6. **Implement** — only now can source be edited. Apply each task with `edit(oldText, newText)`, verifying each Done. Never re-read spec/plan.
7. **Verify** — `workflow action=verify` runs `gates.json` verify commands (e.g. `./gradlew test`) and static rules; the advance to review is BLOCKED until green. Fix failures, re-verify.
8. **Review** — self-review (read-only), commit, then `workflow action=advance` to close.

### gates.json (verification config — per-project `.pi/gates.json` overrides global `~/.pi/agent/gates.json`)
```json
{
  "verify": { "commands": ["./gradlew test", "./gradlew ktlintCheck"] },
  "rules": [
    { "id": "no-copy-in-tests", "mode": "forbidden", "command": "grep -rn '\\.copy(' --include='*Test.kt' src/ test/ 2>/dev/null" },
    { "id": "no-todo", "mode": "forbidden", "command": "grep -rn 'TODO' src/ 2>/dev/null" }
  ]
}
```
A `verify.commands` entry must exit 0. A `rule` passes when a `forbidden` command finds nothing, or a `required` command finds something.

## Non-negotiable moves
- WHAT before HOW — spec never mentions a stack or code structure.
- Vertical slices — every story independently shippable; P1 = MVP.
- Never guess — `[NEEDS CLARIFICATION]` over invented detail.
- Measurable success criteria and Given/When/Then acceptance.
- Non-goals + ≥1 rejected alternative per major decision.
- Test-first: write tests, confirm they fail, then implement.
- Discover something new mid-execution → go back and update the spec/plan first.

## Memory
Spec/plan/tasks are working artifacts in `specs/<NNN-slug>/`. Record only durable decisions in `.ai/decisions/` (see `engineering-memory`) — not every detail.
