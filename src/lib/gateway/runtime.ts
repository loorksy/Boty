/**
 * Gateway tick work owned by the resident host. External cron is a watchdog
 * that runs the same job only when this heartbeat is stale.
 */
import { createLogger } from "@/lib/logger";
import { getOwnerId } from "@/lib/ownerIdentity";
import { getFlag, setFlag } from "@/lib/store";
import { execute, queryOne } from "@/lib/db";
import { dispatchDueGoals, getGoal, goalCadenceMs, updateGoalMemory } from "./goals";
import { runMarketWatch } from "./marketMonitor";
import { deliverPendingNotifications, telegramNotificationTransport } from "./notify";
import {
  claimNextTask,
  completeTask,
  failTask,
  finishTaskRun,
  markTaskRunning,
  reclaimStaleTasks,
  startTaskRun,
} from "./tasks";
import { delegateSubAgent, type SubAgentOutput } from "./subagents";
import { isSubAgentRole } from "./roles";

const log = createLogger("gateway.runtime");

export const HEARTBEAT_FLAG = "gateway_heartbeat";
export const PAUSED_FLAG = "gateway_paused";

export function heartbeatIsFresh(at: number, now = Date.now(), staleMs?: number): boolean {
  const stale = staleMs ?? Number(process.env.GATEWAY_HEARTBEAT_STALE_MS || 180_000);
  return now - at < stale;
}

export async function recordGatewayHeartbeat(backend: string, at = Date.now()): Promise<void> {
  await setFlag(
    HEARTBEAT_FLAG,
    JSON.stringify({ at, backend, pid: process.pid }),
  );
}

export async function readGatewayHeartbeat(): Promise<{ at: number; backend: string; pid: number } | null> {
  const raw = await getFlag(HEARTBEAT_FLAG);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: number; backend?: string; pid?: number };
    if (typeof parsed.at !== "number") return null;
    return {
      at: parsed.at,
      backend: parsed.backend ?? "unknown",
      pid: parsed.pid ?? 0,
    };
  } catch {
    return null;
  }
}

export async function gatewayHeartbeatFresh(now = Date.now()): Promise<boolean> {
  const beat = await readGatewayHeartbeat();
  if (!beat) return false;
  return heartbeatIsFresh(beat.at, now);
}

export async function isGatewayPaused(): Promise<boolean> {
  return (await getFlag(PAUSED_FLAG)) === "1";
}

export async function setGatewayPaused(paused: boolean): Promise<void> {
  await setFlag(PAUSED_FLAG, paused ? "1" : "0");
  log.info("gateway.pause", { paused });
}

export async function runMarketWatchTick(): Promise<void> {
  if (await isGatewayPaused()) {
    log.info("market.watch.skipped", { reason: "paused" });
    return;
  }
  const ownerId = await getOwnerId();
  if (ownerId == null) {
    log.error("market.watch.skipped", { reason: "owner_missing" });
    return;
  }
  await runMarketWatch({ ownerId });
}

export async function runGoalDispatchTick(): Promise<void> {
  if (await isGatewayPaused()) {
    log.info("goal.dispatch.skipped", { reason: "paused" });
    return;
  }
  const created = await dispatchDueGoals();
  log.info("goal.dispatch", { created });
}

const GUARDIAN_PARENT = "gateway-guardian";
const GUARDIAN_FLAG = "gateway_guardian_signature";

export async function settleTaskOutput(taskId: string, output: SubAgentOutput, runId: string | null): Promise<void> {
  const { getTask } = await import("./tasks");
  const task = await getTask(taskId);
  if (!task) return;
  const terminal = output.status === "completed" ? "completed" : output.status === "cancelled" ? "cancelled" : "failed";
  if (runId) {
    await finishTaskRun(runId, {
      status: terminal,
      summary: output.summary,
      evidence: output.evidence,
      warnings: output.warnings,
      error: output.errors[0] ?? null,
      tokens: output.tokens,
      costUsd: Number((output.evidence.find((row) => typeof row.costUsd === "number") as { costUsd?: number } | undefined)?.costUsd ?? 0),
      subAgentId: output.subAgentId ?? null,
    });
  }
  if (output.status === "completed") {
    await completeTask(task.id, { summary: output.summary, evidence: output.evidence }, output.summary);
  } else {
    await failTask(task.id, output.errors[0] ?? output.summary);
  }
  if (!task.goalId) return;
  const goal = await getGoal(task.goalId);
  if (!goal) return;
  const retrying = output.status !== "completed" && task.attempt < task.maxAttempts;
  const fingerprint = typeof task.input.fingerprint === "string" ? task.input.fingerprint : undefined;
  await updateGoalMemory(task.goalId, {
    summary: output.summary,
    latestFindings: JSON.stringify(output.evidence).slice(0, 2_000),
    lastAction: retrying ? `retrying ${task.role}` : `${terminal} ${task.role}`,
    fingerprint,
    nextCheckAt: retrying ? goal.nextCheckAt : new Date(Date.now() + goalCadenceMs(goal)).toISOString(),
  });
}

export async function runTaskReclaimTick(): Promise<void> {
  const reclaimed = await reclaimStaleTasks();
  const ownerId = await getOwnerId();
  if (ownerId == null) return;
  const task = await claimNextTask(`gateway-${process.pid}`);
  if (!task) {
    log.info("task.reclaim", { reclaimed, ran: false });
    return;
  }
  const runId = await startTaskRun({
    taskId: task.id,
    attempt: task.attempt,
    parentRunId: task.parentTaskId,
  });
  if (task.deadlineAt && Date.parse(task.deadlineAt) < Date.now()) {
    await finishTaskRun(runId, { status: "failed", error: "deadline_exceeded", summary: "deadline_exceeded" });
    await failTask(task.id, "deadline_exceeded");
    log.info("task.reclaim", { reclaimed, ran: false, error: "deadline_exceeded", taskId: task.id, runId });
    return;
  }
  await markTaskRunning(task.id);
  if (!isSubAgentRole(task.role)) {
    await finishTaskRun(runId, { status: "failed", error: "unknown_role", summary: "unknown_role" });
    await failTask(task.id, "unknown_role");
    return;
  }
  const output = await delegateSubAgent({
    role: task.role,
    objective: task.objective,
    parentRunId: runId,
    taskId: task.id,
    depth: 0,
    context: { ...task.input, ownerId },
    allowNotify: task.role === "market_watcher",
  });
  await settleTaskOutput(task.id, output, runId);
  log.info("task.reclaim", { reclaimed, ran: true, taskId: task.id, runId, status: output.status });
}

export async function runNotificationDeliveryTick(): Promise<void> {
  const transport = await telegramNotificationTransport();
  const report = await deliverPendingNotifications(transport);
  log.info("notify.delivery", { ...report });
}

export async function runGuardianTick(): Promise<void> {
  const ownerId = await getOwnerId();
  if (ownerId == null) return;
  await execute(
    "DELETE FROM agent_subagents WHERE role = 'system_guardian' AND parent_run_id != ?",
    [GUARDIAN_PARENT],
  );
  const { countTasksByStatus } = await import("./tasks");
  const counts = await countTasksByStatus();
  const signature = JSON.stringify({
    failed: counts.failed ?? 0,
    waiting: counts.waiting_for_approval ?? 0,
  });
  const previous = await getFlag(GUARDIAN_FLAG);
  if (previous === signature) return;
  await setFlag(GUARDIAN_FLAG, signature);
  const summary = (counts.failed ?? 0) > 0
    ? `Gateway has ${counts.failed} failed task(s).`
    : "Gateway task ledger is clear.";
  const now = new Date().toISOString();
  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM agent_subagents WHERE parent_run_id = ? AND role = 'system_guardian' LIMIT 1",
    [GUARDIAN_PARENT],
  );
  if (existing) {
    await execute(
      `UPDATE agent_subagents
       SET status = 'completed', objective = ?, result_json = ?, error = NULL, finished_at = ?
       WHERE id = ?`,
      [summary, JSON.stringify({ summary, counts }), now, existing.id],
    );
    return;
  }
  const { randomUUID } = await import("node:crypto");
  await execute(
    `INSERT INTO agent_subagents (
      id, task_id, parent_run_id, role, status, objective, allowed_tools_json,
      allowed_skills_json, depth, result_json, created_at, finished_at
    ) VALUES (?, NULL, ?, 'system_guardian', 'completed', ?, '[]', '[]', 0, ?, ?, ?)`,
    [randomUUID(), GUARDIAN_PARENT, summary, JSON.stringify({ summary, counts }), now, now],
  );
}
