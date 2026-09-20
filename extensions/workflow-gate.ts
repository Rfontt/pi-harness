import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

// Workflow-gate: the spec -> plan -> tasks -> implement -> review -> done chain,
// enforced as a state machine in code. spec/plan/tasks are read-only over source;
// only the current phase's artifact (specs/<slug>/) is writable. Human /approve gates
// spec/plan/tasks transitions. The implement -> review transition is gated by VERIFY:
// the project's test/lint commands (gates.json → verify.commands) must exit 0 AND the
// static rules (gates.json → rules) must pass. The model cannot declare "tests passed"
// — the harness runs them.

const execAsync = promisify(exec);

type Phase = "spec" | "plan" | "tasks" | "implement" | "review" | "done";

type WorkflowState = {
  slug: string;
  phase: Phase;
  pendingApproval: Phase | null;
  updated: string;
};

type Rule = {
  id: string;
  description?: string;
  mode?: "forbidden" | "required";
  command: string;
};

type Gates = {
  verify: { commands: string[] };
  rules: Rule[];
};

const NEXT: Record<Phase, Phase | null> = {
  spec: "plan",
  plan: "tasks",
  tasks: "implement",
  implement: "review",
  review: "done",
  done: null,
};

const REQUIRES_APPROVAL: Record<Phase, boolean> = {
  spec: true,
  plan: true,
  tasks: true,
  implement: false,
  review: false,
  done: false,
};

const ARTIFACT: Record<Phase, string | null> = {
  spec: "spec.md",
  plan: "plan.md",
  tasks: "tasks.md",
  implement: null,
  review: null,
  done: null,
};

function projectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".ai")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

function baseDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function statePath(cwd: string): string {
  return join(projectRoot(cwd), ".pi", "workflow.json");
}

function loadState(cwd: string): WorkflowState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(cwd), "utf8"));
    if (typeof raw?.slug === "string" && typeof raw?.phase === "string") {
      return { slug: raw.slug, phase: raw.phase, pendingApproval: raw.pendingApproval ?? null, updated: raw.updated ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}

function saveState(cwd: string, state: WorkflowState): void {
  const p = statePath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  state.updated = new Date().toISOString();
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function artifactDir(cwd: string, slug: string): string {
  return join(projectRoot(cwd), "specs", slug);
}

function artifactFile(cwd: string, state: WorkflowState): string | null {
  const kind = ARTIFACT[state.phase];
  if (!kind) return null;
  return join(artifactDir(cwd, state.slug), kind);
}

function readArtifact(cwd: string, state: WorkflowState): string {
  const f = artifactFile(cwd, state);
  if (!f) return "";
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "feature";
}

function section(text: string, title: string): string {
  const re = new RegExp("^##\\s+" + title + "\\b", "im");
  const m = text.match(re);
  if (!m || m.index === undefined) return "";
  const rest = text.slice(m.index);
  const next = rest.split(/^##\s+/m)[1];
  return next ? rest.slice(0, rest.indexOf(next, 1)).trim() : rest.trim();
}

function validateSpec(text: string): string[] {
  const missing: string[] = [];
  if (/\[NEEDS CLARIFICATION\]/i.test(text)) missing.push("unresolved [NEEDS CLARIFICATION] markers");
  if (!/##\s+User\s+Stories?/i.test(text) && !/##\s+Functional\s+Requirements/i.test(text)) {
    missing.push("User Stories or Functional Requirements section");
  } else if (!/\b(Given|When)\b/i.test(text)) {
    missing.push("acceptance criteria (Given/When/Then)");
  }
  if (!/##\s+Success\s+Criteria/i.test(text)) missing.push("Success Criteria section");
  if (!/##\s+Edge\s+Cases/i.test(text)) missing.push("Edge Cases section");
  if (!/##\s+Assumptions/i.test(text)) missing.push("Assumptions section");
  return missing;
}

function validatePlan(text: string): string[] {
  const missing: string[] = [];
  if (!/##\s+Summary/i.test(text)) missing.push("Summary section");
  const tc = section(text, "Technical Context");
  if (!tc) missing.push("Technical Context section");
  else if (/NEEDS CLARIFICATION/i.test(tc)) missing.push("unresolved NEEDS CLARIFICATION in Technical Context");
  const cc = section(text, "Constitution Check");
  if (!cc) missing.push("Constitution Check section");
  else if (/\[ \]/.test(cc)) missing.push("unchecked Constitution items");
  if (!/##\s+Structure/i.test(text)) missing.push("Structure section");
  return missing;
}

function validateTasks(text: string): string[] {
  const missing: string[] = [];
  const ids = text.match(/^##\s+(T\d+)/gm)?.map((h) => h.replace(/^##\s+/, "").trim()) ?? [];
  if (!ids.length) {
    missing.push("at least one task block (## T001 ...)");
    return missing;
  }
  const blocks = text.split(/^##\s+T\d+/m).slice(1);
  ids.forEach((id, i) => {
    const b = blocks[i] ?? "";
    if (!/\bFile:/i.test(b)) missing.push(`${id}: File (exact path)`);
    if (!/\bOLD\b/i.test(b)) missing.push(`${id}: OLD (verbatim snippet from the current file)`);
    if (!/\bNEW\b/i.test(b)) missing.push(`${id}: NEW (exact replacement)`);
    if (!/```/.test(b)) missing.push(`${id}: fenced code block (\`\`\`) carrying OLD/NEW`);
    const t = b.match(/\bTest:/i);
    if (!t) missing.push(`${id}: Test (test file + test name)`);
    else if (!/\S/.test(b.slice((t.index ?? 0) + t[0].length))) missing.push(`${id}: Test has no value`);
    if (!/\bDone:/i.test(b)) missing.push(`${id}: Done (objective acceptance criterion)`);
  });
  return missing;
}

function validatorFor(phase: Phase): (text: string) => string[] {
  if (phase === "spec") return validateSpec;
  if (phase === "plan") return validatePlan;
  if (phase === "tasks") return validateTasks;
  return () => [];
}

function under(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + "/");
}

function globalGatesPath(): string {
  return join(baseDir(), "gates.json");
}

function gatesPath(cwd: string): string {
  return join(projectRoot(cwd), ".pi", "gates.json");
}

function loadGates(cwd: string): Gates {
  const result: Gates = { verify: { commands: [] }, rules: [] };
  for (const p of [globalGatesPath(), gatesPath(cwd)]) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(raw?.verify?.commands)) result.verify.commands = raw.verify.commands;
      if (Array.isArray(raw?.rules)) result.rules = raw.rules;
    } catch {
      /* ignore missing/invalid */
    }
  }
  return result;
}

async function run(cmd: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const r = await execAsync(cmd, { cwd, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
    return { exitCode: 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function runVerification(cwd: string): Promise<{ pass: boolean; text: string }> {
  const gates = loadGates(cwd);
  const lines: string[] = [];
  let pass = true;

  if (gates.verify.commands.length) {
    lines.push("verify commands:");
    for (const cmd of gates.verify.commands) {
      const r = await run(cmd, cwd);
      const ok = r.exitCode === 0;
      lines.push(`  ${ok ? "PASS" : "FAIL"}  ${cmd}`);
      if (!ok) {
        pass = false;
        const tail = (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-15).join("\n");
        if (tail) lines.push(tail.split("\n").map((l) => "      " + l).join("\n"));
      }
    }
  }

  if (gates.rules.length) {
    lines.push("rules:");
    for (const rule of gates.rules) {
      const r = await run(rule.command, cwd);
      const out = r.stdout.trim();
      const ok = rule.mode === "required" ? out.length > 0 : out.length === 0;
      lines.push(`  ${ok ? "PASS" : "FAIL"}  ${rule.id}${rule.description ? " — " + rule.description : ""}`);
      if (!ok) {
        pass = false;
        if (out) lines.push(out.split("\n").slice(0, 15).map((l) => "      " + l).join("\n"));
      }
    }
  }

  if (!gates.verify.commands.length && !gates.rules.length) {
    lines.push("(no verify commands or rules configured — gate passes)");
  }

  return { pass, text: lines.join("\n") };
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    if (!state || state.phase === "done") return;
    const parts = [`## Workflow gate (active)`, `Phase: ${state.phase}`];
    if (state.phase === "implement") {
      parts.push(`Implement EXACTLY what is in specs/${state.slug}/tasks.md. Do not re-read spec.md or plan.md.`);
      parts.push(`When done, run workflow action=verify, fix failures, then workflow action=advance to review.`);
    } else if (state.phase === "review") {
      parts.push(`Self-review the changes (/review) and commit if appropriate. Source is read-only now.`);
      parts.push(`workflow action=advance to close (done).`);
    } else {
      parts.push(`Writable now: specs/${state.slug}/${ARTIFACT[state.phase]} and .ai/ only (source is read-only until implement).`);
      parts.push(`Next: produce a valid ${ARTIFACT[state.phase]}, then /approve to advance to ${NEXT[state.phase]}.`);
    }
    if (state.pendingApproval) parts.push(`Awaiting your /approve to advance to ${state.pendingApproval}.`);
    return { systemPrompt: (event.systemPrompt ?? "") + "\n\n" + parts.join("\n") + "\n" };
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    if (!state || state.phase === "done") return;
    const phase = state.phase;

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      if (phase === "implement") return;
      const path = (event.input as { path: string }).path;
      const target = resolve(ctx.cwd, path);
      const specsDir = artifactDir(ctx.cwd, state.slug);
      const aiDir = join(projectRoot(ctx.cwd), ".ai");
      if (under(target, aiDir)) return;
      if (under(target, specsDir)) {
        const allowed = ARTIFACT[phase];
        if (allowed && basename(target) === allowed) return;
      }
      const reason =
        phase === "review"
          ? `workflow phase 'review' — source is read-only (review/commit only).`
          : `workflow phase '${phase}' — source is read-only until 'implement'. Writable now: ${ARTIFACT[phase] ? `specs/${state.slug}/${ARTIFACT[phase]}` : "nothing"} and .ai/.`;
      return { block: true, reason: `workflow-gate: ${reason}`, terminate: true };
    }
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow gate",
    description:
      "Drive the spec -> plan -> tasks -> implement -> review -> done chain. Start, inspect phase, validate the " +
      "current artifact (check), run the verification gate (verify — project test/lint commands + static rules), " +
      "and request advancement (advance). spec/plan/tasks transitions require the human /approve; implement -> review " +
      "requires verification to pass; the model cannot self-advance past either.",
    promptGuidelines: [
      "Use action=start with slug once at the beginning of a feature.",
      "After writing the current artifact, run action=check; fix every missing field, re-check until clean, then the human types /approve.",
      "In implement phase, after applying the tasks, run action=verify (runs gates.json commands + rules), fix failures, then action=advance.",
      "Never write plan.md/tasks.md before the previous artifact is approved — the gate blocks it in code.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("status"),
        Type.Literal("check"),
        Type.Literal("verify"),
        Type.Literal("advance"),
      ]),
      slug: Type.Optional(Type.String({ description: "Feature slug, e.g. '042-payment-refund' (required for start)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const out = (text: string) => ({ content: [{ type: "text", text }], details: {} });
      const cwd = _ctx.cwd;
      const action = params.action as string;

      if (action === "start") {
        const slug = slugify((params.slug ?? "").trim() || "feature");
        const dir = artifactDir(cwd, slug);
        mkdirSync(dir, { recursive: true });
        saveState(cwd, { slug, phase: "spec", pendingApproval: null, updated: "" });
        return out(`workflow started: specs/${slug}/ (phase=spec). Write spec.md now.`);
      }

      const state = loadState(cwd);
      if (!state) return out("no active workflow — run workflow action=start first.");

      if (action === "status") {
        const lines = [
          `workflow: specs/${state.slug}`,
          `phase: ${state.phase}`,
          state.phase === "implement"
            ? "writable: source files + specs/ + .ai/ (verify before advancing)"
            : state.phase === "review"
              ? "writable: .ai/ only (source read-only; commit allowed)"
              : `writable: specs/${state.slug}/${ARTIFACT[state.phase]} + .ai/ (source read-only)`,
        ];
        if (state.pendingApproval) lines.push(`awaiting /approve -> ${state.pendingApproval}`);
        if (state.phase !== "implement" && state.phase !== "review" && state.phase !== "done") {
          const text = readArtifact(cwd, state);
          const miss = validatorFor(state.phase)(text);
          lines.push(text ? `${ARTIFACT[state.phase]}: ${miss.length ? "INVALID — " + miss.join("; ") : "valid"}` : `${ARTIFACT[state.phase]}: not written yet`);
        }
        return out(lines.join("\n"));
      }

      if (action === "check") {
        const text = readArtifact(cwd, state);
        if (!text) return out(`${ARTIFACT[state.phase]} does not exist yet. Write it first.`);
        const miss = validatorFor(state.phase)(text);
        return miss.length ? out(`INVALID (${state.phase}):\n- ${miss.join("\n- ")}`) : out(`VALID (${state.phase}). Ready for /approve.`);
      }

      if (action === "verify") {
        const v = await runVerification(cwd);
        return out(v.text + (v.pass ? "\n\nAll checks passed. Run workflow action=advance to move to review." : "\n\nVerification FAILED — fix and re-run workflow action=verify."));
      }

      if (action === "advance") {
        const next = NEXT[state.phase];
        if (!next) return out("workflow is already done.");

        if (state.phase === "implement") {
          const v = await runVerification(cwd);
          if (!v.pass) {
            return out(`cannot advance — verification failed:\n${v.text}\n\nYou're still in 'implement'. Fix the failures, then workflow action=verify again.`);
          }
          state.phase = next;
          state.pendingApproval = null;
          saveState(cwd, state);
          return out(`verification passed. Advanced to ${next} (review).`);
        }

        if (state.phase === "review") {
          state.phase = next;
          state.pendingApproval = null;
          saveState(cwd, state);
          return out(`advanced to ${next}.`);
        }

        const text = readArtifact(cwd, state);
        const miss = validatorFor(state.phase)(text);
        if (miss.length) return out(`cannot advance — ${ARTIFACT[state.phase]} invalid:\n- ${miss.join("\n- ")}`);

        if (REQUIRES_APPROVAL[state.phase]) {
          state.pendingApproval = next;
          saveState(cwd, state);
          return out(`VALID. Marked awaiting approval. The human must type /approve to advance ${state.phase} -> ${next}.`);
        }
        state.phase = next;
        state.pendingApproval = null;
        saveState(cwd, state);
        return out(`advanced to ${next}.`);
      }

      return out("unknown action — use start | status | check | verify | advance.");
    },
  });

  pi.registerCommand("approve", {
    description: "Approve the current workflow artifact and advance to the next phase (human gate)",
    handler: async (_args, ctx) => {
      const state = loadState(ctx.cwd);
      if (!state) {
        ctx.ui.notify("workflow-gate: no active workflow.", "error");
        return;
      }
      if (!state.pendingApproval) {
        ctx.ui.notify(`workflow-gate: nothing awaiting approval (phase=${state.phase}).`, "warning");
        return;
      }
      const text = readArtifact(ctx.cwd, state);
      const miss = validatorFor(state.phase)(text);
      if (miss.length) {
        ctx.ui.notify(`workflow-gate: ${ARTIFACT[state.phase]} still invalid — ${miss.join("; ")}`, "error");
        return;
      }
      const next = state.pendingApproval;
      state.phase = next;
      state.pendingApproval = null;
      saveState(ctx.cwd, state);
      ctx.ui.notify(`workflow-gate: approved. ${next === "implement" ? "phase=implement — implement from tasks.md." : `phase=${next} — write ${ARTIFACT[next]} now.`}`, "info");
    },
  });
}
