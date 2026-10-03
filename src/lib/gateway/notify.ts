/**
 * Proactive owner notifications. Delivery intent is durable, deduped, and
 * rate-limited. A retry updates the same row; it does not mint a second one.
 */
import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { createLogger } from "@/lib/logger";

const log = createLogger("gateway.notify");

export interface NotificationClaim {
  deliver: boolean;
  reason: string;
  id: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function maxPerHour(): number {
  const raw = Number(process.env.GATEWAY_NOTIFY_MAX_PER_HOUR || 6);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 6;
}

export async function claimNotification(input: {
  ownerId: number;
  dedupeKey: string;
  channel: string;
  reason: string;
  body: string;
  goalId?: string | null;
  taskId?: string | null;
}): Promise<NotificationClaim> {
  const existing = await queryOne<{ id: string; status: string }>(
    "SELECT id, status FROM gateway_notifications WHERE dedupe_key = ?",
    [input.dedupeKey],
  );
  if (existing) {
    log.info("notify.duplicate", { id: existing.id, dedupeKey: input.dedupeKey, status: existing.status });
    return { deliver: false, reason: "duplicate", id: existing.id };
  }
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM gateway_notifications
     WHERE owner_id = ? AND channel = ? AND created_at >= ? AND status IN ('pending', 'sent')`,
    [input.ownerId, input.channel, since],
  );
  if (Number(recent?.n ?? 0) >= maxPerHour()) {
    log.info("notify.rate_limited", { channel: input.channel, reason: input.reason });
    return { deliver: false, reason: "rate_limited", id: null };
  }
  const id = randomUUID();
  const now = nowIso();
  try {
    await execute(
      `INSERT INTO gateway_notifications (
        id, owner_id, dedupe_key, channel, reason, body, status, attempts,
        goal_id, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [
        id,
        input.ownerId,
        input.dedupeKey,
        input.channel,
        input.reason,
        input.body,
        input.goalId ?? null,
        input.taskId ?? null,
        now,
      ],
    );
  } catch {
    const raced = await queryOne<{ id: string }>(
      "SELECT id FROM gateway_notifications WHERE dedupe_key = ?",
      [input.dedupeKey],
    );
    return { deliver: false, reason: "duplicate", id: raced?.id ?? null };
  }
  log.info("notify.claimed", { id, reason: input.reason, channel: input.channel, taskId: input.taskId ?? null });
  return { deliver: true, reason: input.reason, id };
}

export async function markNotificationSent(id: string): Promise<void> {
  const now = nowIso();
  await execute(
    `UPDATE gateway_notifications
     SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL
     WHERE id = ?`,
    [now, id],
  );
}

export async function markNotificationFailed(id: string, error: string): Promise<void> {
  await execute(
    `UPDATE gateway_notifications
     SET status = 'retry', attempts = attempts + 1, error = ?
     WHERE id = ?`,
    [error.slice(0, 300), id],
  );
  log.error("notify.failed", { id, error });
}

export async function listNotifications(limit = 20): Promise<Array<Record<string, unknown>>> {
  return query(
    "SELECT id, channel, reason, status, attempts, error, goal_id, task_id, created_at, sent_at FROM gateway_notifications ORDER BY created_at DESC LIMIT ?",
    [Math.min(100, limit)],
  );
}
