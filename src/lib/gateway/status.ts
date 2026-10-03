/**
 * Private gateway status. Operational facts only — no secrets, no prompts.
 */
import { releaseIdentity } from "@/lib/version";
import { getOwnerId } from "@/lib/ownerIdentity";
import { queryOne } from "@/lib/db";
import { listPendingApprovals } from "./approvals";
import { listGoals } from "./goals";
import { countTasksByStatus, listTaskRuns, listTasks } from "./tasks";
import { listSubAgents } from "./subagents";
import { lastMarketEvent } from "./marketMonitor";
import { ownerCostSummary } from "./costs";
import { isGatewayPaused, readGatewayHeartbeat } from "./runtime";

export interface GatewayStatus {
  ok: boolean;
  status: "running" | "paused" | "degraded";
  uptimeMs: number | null;
  version: string;
  commit: string;
  queue: { backend: string; pending: number | null; inFlight: number | null };
  heartbeat: { at: number; ageMs: number; backend: string } | null;
  redis: { configured: boolean; required: boolean };
  tasks: Record<string, number>;
  goals: { active: number; paused: number; completed: number; failed: number; cancelled: number };
  goalItems: Array<{ id: string; title: string; status: string }>;
  subagents: Array<{ id: string; role: string; status: string; objective: string; createdAt: string; finishedAt: string | null }>;
  market: Record<string, unknown> | null;
  openRecommendations: number | null;
  costs: { todayUsd: number; monthUsd: number };
  providers: { openai: boolean; anthropic: boolean };
  paused: boolean;
  recentTasks: Array<{ id: string; role: string; status: string; error: string | null; updatedAt: string }>;
  recentRuns: Array<{ id: string; taskId: string; status: string; attempt: number; summary: string | null; startedAt: string; finishedAt: string | null }>;
  approvals: Array<{ id: string; taskId: string | null; toolName: string | null; reason: string; status: string }>;
  failures: string[];
}

export async function buildGatewayStatus(input: {
  uptimeMs?: number | null;
  queueBackend?: string;
  queuePending?: number | null;
  queueInFlight?: number | null;
} = {}): Promise<GatewayStatus> {
  const failures: string[] = [];
  const beat = await readGatewayHeartbeat().catch((err) => {
    failures.push(err instanceof Error ? err.message : "heartbeat_unreadable");
    return null;
  });
  const paused = await isGatewayPaused();
  const goals = await listGoals().catch((err) => {
    failures.push(err instanceof Error ? err.message : "goals_unreadable");
    return [];
  });
  const taskCounts = await countTasksByStatus().catch((err) => {
    failures.push(err instanceof Error ? err.message : "tasks_unreadable");
    return {};
  });
  const recent = await listTasks({ limit: 8 }).catch(() => []);
  const runs = await listTaskRuns(undefined, 8).catch(() => []);
  const approvals = await listPendingApprovals(8).catch(() => []);
  const subs = await listSubAgents(8).catch(() => []);
  const market = await lastMarketEvent().catch(() => null);
  const costs = await ownerCostSummary().catch((err) => {
    failures.push(err instanceof Error ? err.message : "costs_unreadable");
    return { todayUsd: 0, monthUsd: 0, byModel: [], todayByKind: [] };
  });
  const ownerId = await getOwnerId();
  let openRecommendations: number | null = null;
  if (ownerId != null) {
    const row = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tracked_recommendations WHERE user_id = ? AND status NOT IN ('expired', 'invalidated', 'completed', 'stopped', 'target_hit', 'stop_hit')",
      [ownerId],
    ).catch(() => null);
    openRecommendations = row ? Number(row.n) : null;
  }
  const identity = releaseIdentity();
  const redisConfigured = Boolean(process.env.REDIS_URL?.trim());
  const ageMs = beat ? Date.now() - beat.at : null;
  const redisRequired = process.env.NODE_ENV === "production";
  if (redisRequired && !redisConfigured) failures.push("redis_unavailable");
  if (market && market.error) failures.push(String(market.error));
  const degraded = failures.length > 0;
  const goalCount = (status: string) => goals.filter((goal) => goal.status === status).length;
  return {
    ok: !degraded,
    status: paused ? "paused" : degraded ? "degraded" : "running",
    uptimeMs: input.uptimeMs ?? (ageMs != null ? ageMs : null),
    version: identity.version,
    commit: identity.commit,
    queue: {
      backend: input.queueBackend ?? beat?.backend ?? (redisConfigured ? "redis-streams" : "memory"),
      pending: input.queuePending ?? null,
      inFlight: input.queueInFlight ?? null,
    },
    heartbeat: beat && ageMs != null ? { at: beat.at, ageMs, backend: beat.backend } : null,
    redis: { configured: redisConfigured, required: redisRequired },
    tasks: taskCounts,
    goals: {
      active: goalCount("active"),
      paused: goalCount("paused"),
      completed: goalCount("completed"),
      failed: goalCount("failed"),
      cancelled: goalCount("cancelled"),
    },
    goalItems: goals.slice(0, 8).map((goal) => ({
      id: goal.id,
      title: goal.title,
      status: goal.status,
    })),
    subagents: subs.map((row) => ({
      id: row.id,
      role: row.role,
      status: row.status,
      objective: row.objective,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    })),
    market,
    openRecommendations,
    costs: { todayUsd: costs.todayUsd, monthUsd: costs.monthUsd },
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    },
    paused,
    recentTasks: recent.map((task) => ({
      id: task.id,
      role: task.role,
      status: task.status,
      error: task.error,
      updatedAt: task.updatedAt,
    })),
    recentRuns: runs.map((run) => ({
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      attempt: run.attempt,
      summary: run.summary,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    approvals: approvals.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      toolName: row.toolName,
      reason: row.reason,
      status: row.status,
    })),
    failures,
  };
}
