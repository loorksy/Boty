/**
 * Gateway tick work owned by the resident host. External cron is a watchdog
 * that runs the same job only when this heartbeat is stale.
 */
import { createLogger } from "@/lib/logger";
import { getOwnerId } from "@/lib/ownerIdentity";
import { getFlag, setFlag } from "@/lib/store";
import { dispatchDueGoals } from "./goals";
import { runMarketWatch } from "./marketMonitor";
import { claimNextTask, markTaskRunning, failTask, reclaimStaleTasks } from "./tasks";
import { delegateSubAgent } from "./subagents";
import { isSubAgentRole } from "./roles";

const log = createLogger("gateway.runtime");

export const HEARTBEAT_FLAG = "gateway_heartbeat";
export const PAUSED_FLAG = "gateway_paused";

export async function recordGatewayHeartbeat(backend: string): Promise<void> {
  await setFlag(
    HEARTBEAT_FLAG,
    JSON.stringify({ at: Date.now(), backend, pid: process.pid }),
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
  const stale = Number(process.env.GATEWAY_HEARTBEAT_STALE_MS || 180_000);
  return now - beat.at < stale;
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

export async function runTaskReclaimTick(): Promise<void> {
  const reclaimed = await reclaimStaleTasks();
  const ownerId = await getOwnerId();
  if (ownerId == null) return;
  const task = await claimNextTask(`gateway-${process.pid}`);
  if (!task) {
    log.info("task.reclaim", { reclaimed, ran: false });
    return;
  }
  if (task.deadlineAt && Date.parse(task.deadlineAt) < Date.now()) {
    await failTask(task.id, "deadline_exceeded");
    log.info("task.reclaim", { reclaimed, ran: false, error: "deadline_exceeded", taskId: task.id });
    return;
  }
  await markTaskRunning(task.id);
  if (!isSubAgentRole(task.role)) {
    await failTask(task.id, "unknown_role");
    return;
  }
  const output = await delegateSubAgent({
    role: task.role,
    objective: task.objective,
    parentRunId: task.id,
    taskId: task.id,
    depth: 0,
    context: task.input,
    allowNotify: task.role === "market_watcher",
  });
  if (output.status === "completed") {
    const { completeTask } = await import("./tasks");
    await completeTask(task.id, { summary: output.summary, evidence: output.evidence }, output.summary);
  } else {
    await failTask(task.id, output.errors[0] ?? output.summary);
  }
  log.info("task.reclaim", { reclaimed, ran: true, taskId: task.id, status: output.status });
}

export async function runGuardianTick(): Promise<void> {
  const ownerId = await getOwnerId();
  if (ownerId == null) return;
  await delegateSubAgent({
    role: "system_guardian",
    objective: "Inspect gateway task failures.",
    parentRunId: `guardian-${Date.now()}`,
    depth: 0,
    context: {},
  });
}
