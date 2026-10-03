/**
 * Durable task lifecycle. A process restart reclaims expired leases;
 * it does not forget the task.
 */
import { randomUUID } from "node:crypto";
import { execute, query, queryOne, transaction } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { getOwnerId } from "@/lib/ownerIdentity";

const log = createLogger("gateway.tasks");

export const TASK_STATUSES = [
  "queued",
  "claimed",
  "running",
  "waiting",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const OPEN_STATUSES = ["queued", "claimed", "running", "waiting", "waiting_for_approval"] as const;
const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

export interface AgentTask {
  id: string;
  ownerId: number;
  goalId: string | null;
  parentTaskId: string | null;
  role: string;
  objective: string;
  status: TaskStatus;
  idempotencyKey: string | null;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  deadlineAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateTaskInput {
  ownerId?: number;
  goalId?: string | null;
  parentTaskId?: string | null;
  role: string;
  objective: string;
  idempotencyKey?: string | null;
  maxAttempts?: number;
  deadlineAt?: string | null;
  input?: Record<string, unknown>;
}

interface TaskRow {
  id: string;
  owner_id: number;
  goal_id: string | null;
  parent_task_id: string | null;
  role: string;
  objective: string;
  status: string;
  idempotency_key: string | null;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  deadline_at: string | null;
  input_json: string;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function mapTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    ownerId: Number(row.owner_id),
    goalId: row.goal_id,
    parentTaskId: row.parent_task_id,
    role: row.role,
    objective: row.objective,
    status: row.status as TaskStatus,
    idempotencyKey: row.idempotency_key,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    deadlineAt: row.deadline_at,
    input: parseJson(row.input_json) ?? {},
    output: parseJson(row.output_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function requireOwnerId(explicit?: number): Promise<number> {
  if (explicit != null) return explicit;
  const id = await getOwnerId();
  if (id == null) throw new Error("owner_missing");
  return id;
}

export async function getTask(id: string): Promise<AgentTask | null> {
  const row = await queryOne<TaskRow>("SELECT * FROM agent_tasks WHERE id = ?", [id]);
  return row ? mapTask(row) : null;
}

export async function findTaskByIdempotency(key: string): Promise<AgentTask | null> {
  const row = await queryOne<TaskRow>(
    "SELECT * FROM agent_tasks WHERE idempotency_key = ?",
    [key],
  );
  return row ? mapTask(row) : null;
}

export async function createTask(input: CreateTaskInput): Promise<AgentTask> {
  if (input.idempotencyKey) {
    const existing = await findTaskByIdempotency(input.idempotencyKey);
    if (existing) return existing;
  }
  const ownerId = await requireOwnerId(input.ownerId);
  const id = randomUUID();
  const now = nowIso();
  try {
    await execute(
      `INSERT INTO agent_tasks (
        id, owner_id, goal_id, parent_task_id, role, objective, status,
        idempotency_key, attempt, max_attempts, deadline_at, input_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        ownerId,
        input.goalId ?? null,
        input.parentTaskId ?? null,
        input.role,
        input.objective,
        input.idempotencyKey ?? null,
        input.maxAttempts ?? 3,
        input.deadlineAt ?? null,
        JSON.stringify(input.input ?? {}),
        now,
        now,
      ],
    );
  } catch (err) {
    if (input.idempotencyKey) {
      const existing = await findTaskByIdempotency(input.idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }
  log.info("task.transition", { taskId: id, goalId: input.goalId ?? null, from: null, to: "queued", role: input.role });
  const created = await getTask(id);
  if (!created) throw new Error("task_insert_failed");
  return created;
}

export async function claimNextTask(workerId: string, leaseMs = 60_000): Promise<AgentTask | null> {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  return transaction(async (helpers) => {
    const rows = await helpers.query<TaskRow>(
      `SELECT t.* FROM agent_tasks t
       LEFT JOIN agent_goals g ON g.id = t.goal_id
       WHERE (
         t.status = 'queued'
         OR (t.status IN ('claimed', 'running') AND t.lease_until IS NOT NULL AND t.lease_until < ?)
       )
       AND (t.goal_id IS NULL OR g.status = 'active')
       ORDER BY t.created_at ASC
       LIMIT 1`,
      [now],
    );
    const row = rows[0];
    if (!row) return null;
    const nextAttempt = Number(row.attempt) + 1;
    if (nextAttempt > Number(row.max_attempts)) {
      await helpers.execute(
        `UPDATE agent_tasks
         SET status = 'failed', error = 'max_attempts', updated_at = ?, finished_at = ?,
             lease_owner = NULL, lease_until = NULL
         WHERE id = ?`,
        [now, now, row.id],
      );
      log.info("task.transition", { taskId: row.id, from: row.status, to: "failed", error: "max_attempts" });
      return null;
    }
    const result = await helpers.execute(
      `UPDATE agent_tasks
       SET status = 'claimed', attempt = ?, lease_owner = ?, lease_until = ?,
           started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
       WHERE id = ? AND status = ?`,
      [nextAttempt, workerId, leaseUntil, now, now, row.id, row.status],
    );
    if (result.changes !== 1) return null;
    log.info("task.transition", {
      taskId: row.id,
      goalId: row.goal_id,
      from: row.status,
      to: "claimed",
      attempt: nextAttempt,
    });
    const claimed = await helpers.query<TaskRow>("SELECT * FROM agent_tasks WHERE id = ?", [row.id]);
    return claimed[0] ? mapTask(claimed[0]) : null;
  });
}

export async function markTaskRunning(id: string): Promise<void> {
  const now = nowIso();
  await execute(
    "UPDATE agent_tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'claimed'",
    [now, id],
  );
  log.info("task.transition", { taskId: id, from: "claimed", to: "running" });
}

export async function completeTask(
  id: string,
  output: Record<string, unknown>,
  summary?: string,
): Promise<void> {
  const now = nowIso();
  await execute(
    `UPDATE agent_tasks
     SET status = 'completed', output_json = ?, error = NULL, updated_at = ?, finished_at = ?,
         lease_owner = NULL, lease_until = NULL
     WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
    [JSON.stringify({ ...output, summary: summary ?? null }), now, now, id],
  );
  log.info("task.transition", { taskId: id, to: "completed" });
}

export async function failTask(id: string, error: string): Promise<void> {
  const now = nowIso();
  const task = await getTask(id);
  if (!task || TERMINAL.has(task.status)) return;
  const retry = task.attempt < task.maxAttempts;
  const status: TaskStatus = retry ? "queued" : "failed";
  await execute(
    `UPDATE agent_tasks
     SET status = ?, error = ?, updated_at = ?, finished_at = ?,
         lease_owner = NULL, lease_until = NULL
     WHERE id = ?`,
    [status, error, now, status === "failed" ? now : null, id],
  );
  log.info("task.transition", { taskId: id, from: task.status, to: status, error });
}

export async function cancelTask(id: string, reason = "cancelled"): Promise<AgentTask | null> {
  const now = nowIso();
  await execute(
    `UPDATE agent_tasks
     SET status = 'cancelled', error = ?, updated_at = ?, finished_at = ?,
         lease_owner = NULL, lease_until = NULL
     WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    [reason, now, now, id],
  );
  log.info("task.transition", { taskId: id, to: "cancelled", error: reason });
  return getTask(id);
}

export async function reclaimStaleTasks(now = Date.now()): Promise<number> {
  const iso = new Date(now).toISOString();
  const stale = await query<TaskRow>(
    `SELECT * FROM agent_tasks
     WHERE status IN ('claimed', 'running')
       AND lease_until IS NOT NULL
       AND lease_until < ?`,
    [iso],
  );
  let reclaimed = 0;
  for (const row of stale) {
    const goal = row.goal_id
      ? await queryOne<{ status: string }>("SELECT status FROM agent_goals WHERE id = ?", [row.goal_id])
      : null;
    if (goal && goal.status !== "active") {
      await cancelTask(row.id, "goal_not_active");
      reclaimed += 1;
      continue;
    }
    if (Number(row.attempt) >= Number(row.max_attempts)) {
      await execute(
        `UPDATE agent_tasks
         SET status = 'failed', error = 'stale_lease', updated_at = ?, finished_at = ?,
             lease_owner = NULL, lease_until = NULL
         WHERE id = ?`,
        [iso, iso, row.id],
      );
      log.info("task.transition", { taskId: row.id, from: row.status, to: "failed", error: "stale_lease" });
    } else {
      await execute(
        `UPDATE agent_tasks
         SET status = 'queued', error = 'stale_lease', updated_at = ?,
             lease_owner = NULL, lease_until = NULL
         WHERE id = ?`,
        [iso, row.id],
      );
      log.info("task.transition", { taskId: row.id, from: row.status, to: "queued", error: "stale_lease" });
    }
    reclaimed += 1;
  }
  return reclaimed;
}

export async function listTasks(opts: { status?: TaskStatus; limit?: number } = {}): Promise<AgentTask[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const rows = opts.status
    ? await query<TaskRow>(
        "SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        [opts.status, limit],
      )
    : await query<TaskRow>("SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?", [limit]);
  return rows.map(mapTask);
}

export async function countTasksByStatus(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM agent_tasks GROUP BY status",
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

export async function openTaskForGoal(goalId: string): Promise<AgentTask | null> {
  const placeholders = OPEN_STATUSES.map(() => "?").join(", ");
  const row = await queryOne<TaskRow>(
    `SELECT * FROM agent_tasks WHERE goal_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC LIMIT 1`,
    [goalId, ...OPEN_STATUSES],
  );
  return row ? mapTask(row) : null;
}

export function isTerminalTask(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}
