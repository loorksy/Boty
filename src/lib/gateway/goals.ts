/**
 * Persistent responsibilities. A goal survives restarts and keeps a compact
 * memory separate from the conversation transcript.
 */
import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { getOwnerId } from "@/lib/ownerIdentity";
import { cancelTask, createTask, openTaskForGoal } from "./tasks";

const log = createLogger("gateway.goals");

export const GOAL_STATUSES = ["active", "paused", "completed", "failed", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalKind = "monitor" | "briefing" | "watch_recommendation" | "research" | "custom";

export interface AgentGoal {
  id: string;
  ownerId: number;
  title: string;
  objective: string;
  status: GoalStatus;
  kind: GoalKind;
  summary: string | null;
  latestFindings: string | null;
  lastAction: string | null;
  nextCheckAt: string | null;
  fingerprint: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface GoalRow {
  id: string;
  owner_id: number;
  title: string;
  objective: string;
  status: string;
  kind: string;
  summary: string | null;
  latest_findings: string | null;
  last_action: string | null;
  next_check_at: string | null;
  fingerprint: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapGoal(row: GoalRow): AgentGoal {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }
  return {
    id: row.id,
    ownerId: Number(row.owner_id),
    title: row.title,
    objective: row.objective,
    status: row.status as GoalStatus,
    kind: row.kind as GoalKind,
    summary: row.summary,
    latestFindings: row.latest_findings,
    lastAction: row.last_action,
    nextCheckAt: row.next_check_at,
    fingerprint: row.fingerprint,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateGoalInput {
  ownerId?: number;
  title: string;
  objective: string;
  kind?: GoalKind;
  cadenceMs?: number;
  config?: Record<string, unknown>;
}

export async function createGoal(input: CreateGoalInput): Promise<AgentGoal> {
  const ownerId = input.ownerId ?? (await getOwnerId());
  if (ownerId == null) throw new Error("owner_missing");
  const id = randomUUID();
  const now = nowIso();
  const cadence = input.cadenceMs ?? 15 * 60 * 1000;
  await execute(
    `INSERT INTO agent_goals (
      id, owner_id, title, objective, status, kind, summary, next_check_at,
      config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerId,
      input.title.slice(0, 160),
      input.objective.slice(0, 4_000),
      input.kind ?? "custom",
      input.objective.slice(0, 500),
      now,
      JSON.stringify({ ...(input.config ?? {}), cadenceMs: cadence }),
      now,
      now,
    ],
  );
  await execute(
    `INSERT INTO agent_schedules (id, goal_id, cadence_ms, next_run_at, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [randomUUID(), id, cadence, now, now, now],
  );
  log.info("goal.created", { goalId: id, kind: input.kind ?? "custom" });
  const goal = await getGoal(id);
  if (!goal) throw new Error("goal_insert_failed");
  return goal;
}

export async function getGoal(id: string): Promise<AgentGoal | null> {
  const row = await queryOne<GoalRow>("SELECT * FROM agent_goals WHERE id = ?", [id]);
  return row ? mapGoal(row) : null;
}

export async function listGoals(status?: GoalStatus): Promise<AgentGoal[]> {
  const rows = status
    ? await query<GoalRow>(
        "SELECT * FROM agent_goals WHERE status = ? ORDER BY updated_at DESC",
        [status],
      )
    : await query<GoalRow>("SELECT * FROM agent_goals ORDER BY updated_at DESC LIMIT 100");
  return rows.map(mapGoal);
}

async function setStatus(id: string, status: GoalStatus, lastAction: string): Promise<AgentGoal | null> {
  const now = nowIso();
  await execute(
    "UPDATE agent_goals SET status = ?, last_action = ?, updated_at = ? WHERE id = ?",
    [status, lastAction, now, id],
  );
  if (status === "paused" || status === "cancelled" || status === "completed" || status === "failed") {
    await execute(
      "UPDATE agent_schedules SET enabled = 0, updated_at = ? WHERE goal_id = ?",
      [now, id],
    );
  }
  if (status === "active") {
    await execute(
      "UPDATE agent_schedules SET enabled = 1, updated_at = ? WHERE goal_id = ?",
      [now, id],
    );
  }
  log.info("goal.transition", { goalId: id, to: status });
  return getGoal(id);
}

export async function pauseGoal(id: string): Promise<AgentGoal | null> {
  return setStatus(id, "paused", "paused");
}

export async function resumeGoal(id: string): Promise<AgentGoal | null> {
  const now = nowIso();
  await execute(
    "UPDATE agent_goals SET status = 'active', last_action = 'resumed', next_check_at = ?, updated_at = ? WHERE id = ?",
    [now, now, id],
  );
  await execute(
    "UPDATE agent_schedules SET enabled = 1, next_run_at = ?, updated_at = ? WHERE goal_id = ?",
    [now, now, id],
  );
  log.info("goal.transition", { goalId: id, to: "active" });
  return getGoal(id);
}

export async function cancelGoal(id: string): Promise<AgentGoal | null> {
  const open = await openTaskForGoal(id);
  if (open) await cancelTask(open.id, "goal_cancelled");
  return setStatus(id, "cancelled", "cancelled");
}

export async function updateGoalMemory(
  id: string,
  patch: {
    summary?: string;
    latestFindings?: string;
    lastAction?: string;
    fingerprint?: string | null;
    nextCheckAt?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  const current = await getGoal(id);
  if (!current) return;
  const nextCheck = patch.nextCheckAt === undefined ? current.nextCheckAt : patch.nextCheckAt;
  await execute(
    `UPDATE agent_goals
     SET summary = ?, latest_findings = ?, last_action = ?, fingerprint = ?,
         next_check_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.summary ?? current.summary,
      patch.latestFindings ?? current.latestFindings,
      patch.lastAction ?? current.lastAction,
      patch.fingerprint === undefined ? current.fingerprint : patch.fingerprint,
      nextCheck,
      now,
      id,
    ],
  );
  if (nextCheck) {
    await execute(
      "UPDATE agent_schedules SET next_run_at = ?, updated_at = ? WHERE goal_id = ?",
      [nextCheck, now, id],
    );
  }
}

/** Compact memory the next task for this goal should read instead of starting blank. */
export function goalMemorySnapshot(goal: AgentGoal): Record<string, unknown> {
  return {
    summary: goal.summary,
    latestFindings: goal.latestFindings,
    lastAction: goal.lastAction,
    fingerprint: goal.fingerprint,
    nextCheckAt: goal.nextCheckAt,
  };
}

export function goalCadenceMs(goal: AgentGoal): number {
  const raw = Number(goal.config.cadenceMs);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 15 * 60 * 1000;
}

/**
 * Active goals whose next check is due get one queued task.
 * Paused and cancelled goals produce nothing.
 */
export async function dispatchDueGoals(now = Date.now()): Promise<number> {
  const iso = new Date(now).toISOString();
  const rows = await query<GoalRow>(
    `SELECT * FROM agent_goals
     WHERE status = 'active' AND (next_check_at IS NULL OR next_check_at <= ?)
     ORDER BY next_check_at ASC
     LIMIT 20`,
    [iso],
  );
  let created = 0;
  for (const row of rows) {
    const goal = mapGoal(row);
    const open = await openTaskForGoal(goal.id);
    if (open) continue;
    const slot = goal.nextCheckAt ?? "initial";
    await createTask({
      ownerId: goal.ownerId,
      goalId: goal.id,
      role: roleForGoal(goal.kind),
      objective: goal.objective,
      idempotencyKey: `goal:${goal.id}:${slot}`,
      input: { kind: goal.kind, title: goal.title, goalMemory: goalMemorySnapshot(goal) },
    });
    const next = new Date(now + goalCadenceMs(goal)).toISOString();
    await execute(
      "UPDATE agent_goals SET next_check_at = ?, last_action = 'scheduled', updated_at = ? WHERE id = ?",
      [next, iso, goal.id],
    );
    await execute(
      "UPDATE agent_schedules SET next_run_at = ?, updated_at = ? WHERE goal_id = ?",
      [next, iso, goal.id],
    );
    created += 1;
    log.info("goal.scheduled", { goalId: goal.id, taskRole: roleForGoal(goal.kind) });
  }
  return created;
}

export function roleForGoal(kind: GoalKind): string {
  switch (kind) {
    case "monitor":
      return "market_watcher";
    case "briefing":
      return "macro_news_analyst";
    case "watch_recommendation":
      return "risk_reviewer";
    case "research":
      return "research_agent";
    default:
      return "supervisor";
  }
}
