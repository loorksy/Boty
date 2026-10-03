/**
 * Bounded delegation. The owner talks to one supervisor. Children cannot
 * create children, cannot exceed the allowlist, and cannot trade.
 */
import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { executeSpecialist } from "./specialists";
import {
  assertToolPermitted,
  TradeBoundaryError,
  type ToolPolicy,
} from "./permissions";
import {
  ROLE_TOOLS,
  SUBAGENT_LIMITS,
  isSubAgentRole,
  type SubAgentRole,
} from "./roles";
import { selectSkillsForRole, type SkillUse } from "./skills";

const log = createLogger("gateway.subagents");

export interface SubAgentRequest {
  role: SubAgentRole;
  objective: string;
  parentRunId: string;
  taskId?: string | null;
  depth: number;
  context?: Record<string, unknown>;
  deadlineMs?: number;
  tokenBudget?: number;
  allowNotify?: boolean;
}

export interface SubAgentOutput {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  evidence: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  warnings: string[];
  errors: string[];
  followUpSuggested: boolean;
  skills: SkillUse[];
  tokens: number;
  subAgentId?: string;
}

export class SubAgentLimitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SubAgentLimitError";
    this.code = code;
  }
}

interface SubAgentRow {
  id: string;
  task_id: string | null;
  parent_run_id: string;
  role: string;
  status: string;
  objective: string;
  depth: number;
  result_json: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function childCount(parentRunId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_subagents WHERE parent_run_id = ?",
    [parentRunId],
  );
  return Number(row?.n ?? 0);
}

async function runningCount(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_subagents WHERE status = 'running'",
  );
  return Number(row?.n ?? 0);
}

function policyFor(role: SubAgentRole, allowNotify: boolean): ToolPolicy {
  return {
    allowlist: ROLE_TOOLS[role],
    allowNotify,
    allowExternalWrite: false,
  };
}

export async function delegateSubAgent(
  request: SubAgentRequest,
  opts: {
    execute?: (request: SubAgentRequest, skills: SkillUse[]) => Promise<SubAgentOutput>;
    now?: () => number;
  } = {},
): Promise<SubAgentOutput> {
  if (!isSubAgentRole(request.role)) {
    throw new SubAgentLimitError("UNKNOWN_ROLE", `Unknown sub-agent role ${request.role}.`);
  }
  if (request.depth >= SUBAGENT_LIMITS.maxDepth) {
    throw new SubAgentLimitError(
      "MAX_DEPTH",
      `Sub-agent depth ${request.depth} exceeds max ${SUBAGENT_LIMITS.maxDepth}.`,
    );
  }
  if ((await childCount(request.parentRunId)) >= SUBAGENT_LIMITS.maxChildren) {
    throw new SubAgentLimitError("MAX_CHILDREN", "Parent run reached the child-agent limit.");
  }
  if ((await runningCount()) >= SUBAGENT_LIMITS.maxConcurrent) {
    throw new SubAgentLimitError("MAX_CONCURRENT", "Too many sub-agents are already running.");
  }
  const policy = policyFor(request.role, request.allowNotify === true);
  for (const tool of policy.allowlist) {
    if (tool.length === 0) throw new TradeBoundaryError(tool);
    assertToolPermitted(tool, policy);
  }
  const skills = selectSkillsForRole(request.role);
  const budget = request.tokenBudget ?? SUBAGENT_LIMITS.maxTokens;
  if (budget <= 0) {
    throw new SubAgentLimitError("BUDGET_EXCEEDED", "Token budget is exhausted.");
  }
  const id = randomUUID();
  const started = nowIso();
  const run = opts.execute ?? executeSpecialist;
  await execute(
    `INSERT INTO agent_subagents (
      id, task_id, parent_run_id, role, status, objective, allowed_tools_json,
      allowed_skills_json, depth, created_at
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    [
      id,
      request.taskId ?? null,
      request.parentRunId,
      request.role,
      request.objective,
      JSON.stringify(policy.allowlist),
      JSON.stringify(skills.used.map((skill) => skill.name)),
      request.depth,
      started,
    ],
  );
  log.info("subagent.start", {
    subAgentId: id,
    parentRunId: request.parentRunId,
    taskId: request.taskId ?? null,
    role: request.role,
    depth: request.depth,
  });
  const timeoutMs = Math.min(request.deadlineMs ?? SUBAGENT_LIMITS.timeoutMs, SUBAGENT_LIMITS.deadlineMs);
  let output: SubAgentOutput;
  try {
    output = await Promise.race([
      run(request, skills.used),
      new Promise<SubAgentOutput>((_, reject) => {
        setTimeout(() => {
          reject(new SubAgentLimitError("TIMEOUT", `Sub-agent timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
    if (output.tokens > budget) {
      output = {
        ...output,
        status: "failed",
        errors: [...output.errors, "budget_exceeded"],
        summary: "Token budget exceeded.",
      };
    }
  } catch (err) {
    const code = err instanceof SubAgentLimitError ? err.code : "SUBAGENT_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    output = {
      status: "failed",
      summary: message,
      evidence: [],
      artifacts: [],
      warnings: [],
      errors: [code],
      followUpSuggested: false,
      skills: skills.used,
      tokens: 0,
    };
  }
  const finished = nowIso();
  output = { ...output, subAgentId: id };
  await execute(
    `UPDATE agent_subagents
     SET status = ?, result_json = ?, error = ?, finished_at = ?
     WHERE id = ?`,
    [
      output.status,
      JSON.stringify(output),
      output.errors[0] ?? null,
      finished,
      id,
    ],
  );
  log.info("subagent.finish", {
    subAgentId: id,
    parentRunId: request.parentRunId,
    role: request.role,
    status: output.status,
    errors: output.errors,
  });
  return output;
}

export async function listSubAgents(limit = 30): Promise<SubAgentRow[]> {
  return query<SubAgentRow>(
    "SELECT * FROM agent_subagents ORDER BY created_at DESC LIMIT ?",
    [Math.min(100, limit)],
  );
}

export async function assertDelegationTools(role: SubAgentRole, extra: string[] = []): Promise<void> {
  const policy = policyFor(role, false);
  for (const tool of [...policy.allowlist, ...extra]) {
    assertToolPermitted(tool, { ...policy, allowlist: [...policy.allowlist, ...extra] });
  }
}
