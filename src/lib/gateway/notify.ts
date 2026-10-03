/**
 * Proactive owner notifications. Delivery intent is durable, deduped, and
 * rate-limited. A retry updates the same row; it does not mint a second one.
 */
import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { createLogger } from "@/lib/logger";

const log = createLogger("gateway.notify");

export type NotificationState = "intent" | "sent" | "retry" | "duplicate" | "rate_limited" | "failed";

export interface NotificationClaim {
  /** Intent is not delivery. `sent` is set only after the transport accepts the message. */
  state: NotificationState;
  reason: string;
  id: string | null;
}

export interface NotificationTransport {
  send(chatId: string, text: string): Promise<void>;
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
    return { state: "duplicate", reason: "duplicate", id: existing.id };
  }
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM gateway_notifications
     WHERE owner_id = ? AND channel = ? AND created_at >= ? AND status IN ('pending', 'sent')`,
    [input.ownerId, input.channel, since],
  );
  if (Number(recent?.n ?? 0) >= maxPerHour()) {
    log.info("notify.rate_limited", { channel: input.channel, reason: input.reason });
    return { state: "rate_limited", reason: "rate_limited", id: null };
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
    return { state: "duplicate", reason: "duplicate", id: raced?.id ?? null };
  }
  log.info("notify.claimed", { id, reason: input.reason, channel: input.channel, taskId: input.taskId ?? null });
  return { state: "intent", reason: input.reason, id };
}

function maxAttempts(): number {
  const raw = Number(process.env.GATEWAY_NOTIFY_MAX_ATTEMPTS || 5);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}

function retryDelayMs(attempt: number): number {
  const base = Number(process.env.GATEWAY_NOTIFY_RETRY_MS || 1_000);
  const floor = Number.isFinite(base) && base >= 0 ? base : 1_000;
  return floor * Math.max(1, attempt);
}

export async function markNotificationFailed(id: string, error: string, attempt = 1): Promise<NotificationState> {
  const terminal = attempt >= maxAttempts();
  const status = terminal ? "failed" : "retry";
  const next = terminal ? null : new Date(Date.now() + retryDelayMs(attempt)).toISOString();
  await execute(
    `UPDATE gateway_notifications
     SET status = ?, error = ?, next_attempt_at = ?
     WHERE id = ?`,
    [status, error.slice(0, 300), next, id],
  );
  log.error("notify.failed", { id, error, status, attempt });
  return terminal ? "failed" : "retry";
}

export interface DeliveryReport {
  sent: number;
  retry: number;
  failed: number;
  skipped: number;
}

/**
 * Drain pending and due retries. A row stays pending across process restarts
 * until a transport accepts it, and a duplicate claim cannot send it twice.
 */
export async function deliverPendingNotifications(
  transport: NotificationTransport,
  opts: { limit?: number; now?: number; chatIdFor?: (ownerId: number) => Promise<string | null> } = {},
): Promise<DeliveryReport> {
  const nowMs = opts.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const staleSending = new Date(nowMs - 60_000).toISOString();
  const rows = await query<{
    id: string;
    owner_id: number;
    body: string;
    attempts: number;
    status: string;
  }>(
    `SELECT id, owner_id, body, attempts, status FROM gateway_notifications
     WHERE (
       status = 'pending'
       OR (status = 'retry' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
       OR (status = 'sending' AND created_at <= ?)
     )
     ORDER BY created_at ASC
     LIMIT ?`,
    [now, staleSending, Math.min(20, opts.limit ?? 10)],
  );
  const chatFor = opts.chatIdFor ?? (async (ownerId: number) => {
    const { getTelegramChatId } = await import("@/lib/store");
    return getTelegramChatId(ownerId);
  });
  const report: DeliveryReport = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const claimed = await execute(
      `UPDATE gateway_notifications
       SET status = 'sending', attempts = attempts + 1, error = NULL
       WHERE id = ? AND status = ?`,
      [row.id, row.status],
    );
    if (claimed.changes !== 1) {
      report.skipped += 1;
      continue;
    }
    const attempt = Number(row.attempts) + 1;
    const chatId = await chatFor(Number(row.owner_id));
    if (!chatId) {
      const state = await markNotificationFailed(row.id, "telegram_owner_unbound", attempt);
      if (state === "failed") report.failed += 1;
      else report.retry += 1;
      continue;
    }
    try {
      await transport.send(chatId, row.body);
      await markNotificationSent(row.id);
      report.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const state = await markNotificationFailed(row.id, message, attempt);
      if (state === "failed") report.failed += 1;
      else report.retry += 1;
    }
  }
  return report;
}

/** Production transport. Tests inject their own sender and never need this. */
export async function telegramNotificationTransport(): Promise<NotificationTransport> {
  const { sendMessage } = await import("@/lib/telegram");
  return {
    async send(chatId: string, text: string) {
      await sendMessage(chatId, text);
    },
  };
}

export async function markNotificationSent(id: string): Promise<void> {
  const now = nowIso();
  await execute(
    `UPDATE gateway_notifications
     SET status = 'sent', sent_at = ?, next_attempt_at = NULL, error = NULL
     WHERE id = ?`,
    [now, id],
  );
}

export async function listNotifications(limit = 20): Promise<Array<Record<string, unknown>>> {
  return query(
    "SELECT id, channel, reason, status, attempts, error, goal_id, task_id, created_at, sent_at FROM gateway_notifications ORDER BY created_at DESC LIMIT ?",
    [Math.min(100, limit)],
  );
}
