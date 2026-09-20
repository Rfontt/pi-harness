import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";

// Safety-gate: enforces Rita's safety rules at the tool level, as code instead
// of prompt instructions. The `tool_call` hook fires after the model requests a
// tool and before it executes; returning { block: true } prevents execution.

const DEFAULT_DENY_BASH: string[] = [
  "rm\\s+-[a-z]*r[a-z]*f",
  "rm\\s+(-r\\s+-f|-f\\s+-r)",
  "git\\s+push\\b[^\\n]*(-f\\b|--force\\b|--force-with-lease)",
  "git\\s+push\\b[^\\n]*--delete",
  "git\\s+branch\\s+-D\\b",
  "git\\s+reset\\s+--hard",
  "git\\s+clean\\b[^\\n]*-[a-z]*f",
  "git\\s+(checkout|restore)\\b[^\\n]*--\\s*\\.?",
  "git\\s+stash\\s+drop\\b",
  "git\\s+reflog\\s+expire\\b[^\\n]*--all",
  "glab\\s+mr\\s+(close|delete)\\b",
  "glab\\s+repo\\s+(delete|archive)\\b",
  "glab\\s+branch\\s+-D\\b",
  ">\\s*/dev/(sd|disk|nvme|mmcblk|vd)",
  "\\bdd\\b[^\\n]*of=/dev/",
  "\\bmkfs\\b",
  "\\bwipefs\\b",
  "curl\\b[^\\n|]*\\|\\s*(ba)?sh\\b",
  "wget\\b[^\\n|]*\\|\\s*(ba)?sh\\b",
  "\\|\\s*(ba)?sh\\s*$",
  "chmod\\s+-R\\s+777",
  "chown\\s+-R\\b",
  "\\bsudo\\s+(rm|dd|mkfs|shutdown|reboot)\\b",
  "\\bshutdown\\b",
  "\\breboot\\b",
  "\\bhalt\\b",
  "\\bpoweroff\\b",
  ":\\{\\s*:\\|:&\\s*\\};:",
  "npm\\s+(i|install)\\s+[^-]\\S+",
  "pnpm\\s+add\\s+[^-]\\S+",
  "yarn\\s+add\\s+[^-]\\S+",
  "pip\\d*\\s+install\\s+[^-]\\S+",
  "brew\\s+(install|cask\\s+install)\\s+[^-]\\S+",
  "cargo\\s+add\\s+[^-]\\S+",
  "go\\s+get\\s+[^-]\\S+",
  "gem\\s+install\\s+[^-]\\S+",
  "\\bcat\\b[^\\n|]*\\.env\\b",
  "\\bcat\\b[^\\n|]*auth\\.json",
  "\\bcat\\b[^\\n|]*(id_rsa|id_ed25519)",
  "\\b(cat|less|head|tail)\\b[^\\n|]*~\\.ssh",
  "\\b(cat|less|head|tail)\\b[^\\n|]*~\\.aws",
  "\\bprintenv\\b",
  "\\becho\\s+\\$\\{?[A-Za-z_0-9]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)",
  "\\benv\\b\\s*\\|\\s*grep\\b[^\\n]*(KEY|TOKEN|SECRET|PASS)",
];

const DEFAULT_PROTECT_PATHS: string[] = [
  "~/.pi/agent/auth.json",
  "~/.pi/agent/models.json",
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  ".env",
  "*.env",
];

const DEFAULT_MAX_WRITE_BYTES = 20000;

type Boundary = "project" | "off";

type Config = {
  blockedTools: string[];
  denyBash: string[];
  allowBash: string[];
  protectPaths: string[];
  boundary: Boundary;
  allowPaths: string[];
  maxWriteBytes: number;
};

function baseDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function configPath(): string {
  return join(baseDir(), "guard.json");
}

function buildConfig(raw?: Record<string, unknown>): Config {
  const r = raw ?? {};
  const arr = (k: string): string[] => (Array.isArray(r[k]) ? (r[k] as string[]) : []);
  return {
    blockedTools: arr("blockedTools"),
    denyBash: [...DEFAULT_DENY_BASH, ...arr("denyBash")],
    allowBash: arr("allowBash"),
    protectPaths: [...DEFAULT_PROTECT_PATHS, ...arr("protectPaths")],
    boundary: r.boundary === "off" ? "off" : "project",
    allowPaths: arr("allowPaths"),
    maxWriteBytes:
      typeof r.maxWriteBytes === "number" ? (r.maxWriteBytes as number) : DEFAULT_MAX_WRITE_BYTES,
  };
}

let cache: { mtimeMs: number; config: Config } | null = null;

function getConfig(): Config {
  try {
    const st = statSync(configPath());
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.config;
    const config = buildConfig(JSON.parse(readFileSync(configPath(), "utf8")));
    cache = { mtimeMs: st.mtimeMs, config };
    return config;
  } catch {
    const config = buildConfig();
    cache = null;
    return config;
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

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

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToReg(pattern: string): RegExp {
  const parts = pattern.split("*").map(escapeReg);
  return new RegExp("^" + parts.join(".*") + "$");
}

function isProtected(target: string, cfg: Config): boolean {
  const abs = resolve(expandHome(target));
  const base = basename(abs);
  for (const p of cfg.protectPaths) {
    const pat = expandHome(p);
    if (pat.includes("*")) {
      if (globToReg(pat).test(abs) || globToReg(pat).test(base)) return true;
    } else {
      const resolved = resolve(pat);
      if (abs === resolved) return true;
      if (abs.startsWith(resolved + "/")) return true;
      if (base === pat) return true;
    }
  }
  return false;
}

function withinRoot(target: string, cwd: string): boolean {
  const root = projectRoot(cwd);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isAllowedPath(target: string, cfg: Config): boolean {
  const abs = resolve(target);
  for (const p of cfg.allowPaths) {
    const allowed = resolve(expandHome(p));
    if (abs === allowed || abs.startsWith(allowed + "/")) return true;
  }
  return false;
}

function secretNeedles(cfg: Config): string[] {
  const needles: string[] = [];
  for (const p of cfg.protectPaths) {
    const pat = expandHome(p);
    if (pat.includes("*")) {
      const suffix = pat.slice(pat.lastIndexOf("*") + 1);
      if (suffix) needles.push(suffix);
      continue;
    }
    needles.push(pat);
    if (p.startsWith("~/")) needles.push(p);
    const base = basename(pat);
    if (base.startsWith(".") || /rsa|key|auth|secret|token|credential|pem|passwd|ed25519|dsa/i.test(base)) {
      needles.push(base);
    }
  }
  return [...new Set(needles)].filter((n) => n.length >= 2);
}

function commandTouchesSecret(cmd: string, cfg: Config): string | undefined {
  for (const n of secretNeedles(cfg)) {
    if (cmd.includes(n)) return n;
  }
  return undefined;
}

function audit(tool: string, reason: string, detail?: string): void {
  try {
    const log = join(baseDir(), "guard-audit.log");
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `${new Date().toISOString()} [${tool}] ${reason}${detail ? " :: " + detail : ""}\n`, "utf8");
  } catch {
    // audit logging must never break the gate
  }
}

function verdict(cmd: string, cfg: Config): { blocked: boolean; rule?: string } {
  const deny = cfg.denyBash.find((p) => new RegExp(p, "i").test(cmd));
  if (!deny) return { blocked: false };
  const allowed = cfg.allowBash.some((p) => new RegExp(p, "i").test(cmd));
  if (allowed) return { blocked: false };
  return { blocked: true, rule: deny };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cfg = getConfig();

    if (cfg.blockedTools.includes(event.toolName)) {
      const reason = `tool '${event.toolName}' is disabled by safety-gate (blockedTools).`;
      audit(event.toolName, reason);
      return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
    }

    if (isToolCallEventType("bash", event)) {
      const cmd = (event.input as { command?: string }).command ?? "";
      const v = verdict(cmd, cfg);
      if (v.blocked) {
        const reason = `command blocked by rule /${v.rule}/i. To allow, add it to guard.json → allowBash.`;
        audit("bash", reason, cmd);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
      const secret = commandTouchesSecret(cmd, cfg);
      if (secret) {
        const reason = `command references a protected path/secret ('${secret}'). Refusing to run.`;
        audit("bash", reason, cmd);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
    }

    if (isToolCallEventType("read", event)) {
      const path = (event.input as { path: string }).path;
      if (isProtected(path, cfg)) {
        const reason = `reading secret path '${path}' is blocked.`;
        audit("read", reason, path);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
    }

    if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      const path = (event.input as { path?: string }).path;
      if (path && isProtected(path, cfg)) {
        const reason = `accessing secret path '${path}' is blocked.`;
        audit(event.toolName, reason, path);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
    }

    if (isToolCallEventType("write", event)) {
      const path = (event.input as { path: string }).path;
      const target = resolve(expandHome(path));
      if (cfg.boundary === "project" && !withinRoot(target, ctx.cwd) && !isAllowedPath(target, cfg)) {
        const reason = `write outside project root is blocked ('${path}'). Add to guard.json → allowPaths to permit.`;
        audit("write", reason, path);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
      if (isProtected(target, cfg)) {
        const reason = `writing secret path '${path}' is blocked.`;
        audit("write", reason, path);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
      if (existsSync(target)) {
        const size = statSync(target).size;
        if (size > cfg.maxWriteBytes) {
          const reason = `overwriting large existing file '${path}' (${size} bytes > maxWriteBytes ${cfg.maxWriteBytes}). Use edit for surgical changes.`;
          audit("write", reason, path);
          return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const path = (event.input as { path: string }).path;
      const target = resolve(expandHome(path));
      if (cfg.boundary === "project" && !withinRoot(target, ctx.cwd) && !isAllowedPath(target, cfg)) {
        const reason = `edit outside project root is blocked ('${path}'). Add to guard.json → allowPaths to permit.`;
        audit("edit", reason, path);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
      if (isProtected(target, cfg)) {
        const reason = `editing secret path '${path}' is blocked.`;
        audit("edit", reason, path);
        return { block: true, reason: `safety-gate: ${reason}`, terminate: true };
      }
    }
  });

  pi.registerTool({
    name: "guard",
    label: "Safety gate check",
    description:
      "Pre-flight a shell command or file path against the safety-gate rules WITHOUT executing anything. " +
      "Use before running a bash command you suspect may be blocked, or to inspect the active rules.",
    promptGuidelines: [
      "Before running an unfamiliar bash command, call guard with action=check and command=<the command> to see if it will be blocked.",
      "Use action=rules to show the active deny/allow/protect configuration when the user asks about safety settings.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("check"), Type.Literal("rules")]),
      command: Type.Optional(Type.String({ description: "Shell command to check against denyBash/allowBash (action=check)." })),
      path: Type.Optional(Type.String({ description: "File path to check against protectPaths/boundary (action=check)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const out = (text: string) => ({ content: [{ type: "text", text }], details: {} });
      const cfg = getConfig();

      if (params.action === "rules") {
        const lines = [
          "safety-gate active rules:",
          `boundary: ${cfg.boundary}`,
          `maxWriteBytes: ${cfg.maxWriteBytes}`,
          `blockedTools: ${cfg.blockedTools.length ? cfg.blockedTools.join(", ") : "(none)"}`,
          `denyBash (${cfg.denyBash.length} patterns):`,
          ...cfg.denyBash.map((p) => `  - /${p}/i`),
          `allowBash (${cfg.allowBash.length}):`,
          ...cfg.allowBash.map((p) => `  - /${p}/i`),
          `protectPaths (${cfg.protectPaths.length}):`,
          ...cfg.protectPaths.map((p) => `  - ${p}`),
          `allowPaths (${cfg.allowPaths.length}):`,
          ...cfg.allowPaths.map((p) => `  - ${p}`),
        ];
        return out(lines.join("\n"));
      }

      if (params.action === "check") {
        const cmd = (params.command ?? "").trim();
        const path = (params.path ?? "").trim();
        if (cmd) {
          const v = verdict(cmd, cfg);
          if (v.blocked) {
            return out(`BLOCKED: ${cmd}\n  rule: /${v.rule}/i`);
          }
          const secret = commandTouchesSecret(cmd, cfg);
          if (secret) {
            return out(`BLOCKED (secret): ${cmd}\n  references protected path/secret: ${secret}`);
          }
          return out(`ALLOWED: ${cmd}`);
        }
        if (path) {
          const target = resolve(expandHome(path));
          if (isProtected(target, cfg)) return out(`BLOCKED (secret): ${path}`);
          if (cfg.boundary === "project" && !withinRoot(target, _ctx.cwd) && !isAllowedPath(target, cfg)) {
            return out(`BLOCKED (outside project root): ${path}`);
          }
          return out(`ALLOWED: ${path}`);
        }
        return out("guard check requires 'command' or 'path'.");
      }

      return out("Unknown action — use check | rules.");
    },
  });
}
