/**
 * External writes wait for the owner. Trade tools never enter this queue:
 * approval does not unlock order placement.
 */
import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { isTradeExecutionTool, TradeBoundaryError } from "./permissions";
import { cancelTask, getTask } from "./tasks";

const log = createLogger("gateway.approvals");

export interface ApprovalRecord {
  id: string;
  taskId: string | null;
  ownerId: number;
  riskClass: string;
  toolName: string | null;
  status: string;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function requestExternalApproval(input: {
  ownerId: number;
  taskId: string;
  toolName: string;
  reason: string;
}): Promise<ApprovalRecord> {
  if (isTradeExecutionTool(input.toolName)) throw new TradeBoundaryError(input.toolName);
  const task = await getTask(input.taskId);
  if (!task) throw new Error("task_missing");
  if (task.ownerId !== input.ownerId) throw new Error("owner_mismatch");
  const id = randomUUID();
  const now = nowIso();
  await execute(
    `UPDATE agent_tasks
     SET status = 'waiting_for_approval', lease_owner = NULL, lease_until = NULL,
         error = NULL, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    [now, input.taskId],
  );
  await execute(
    `INSERT INTO agent_approvals (
      id, task_id, owner_id, risk_class, tool_name, status, reason, created_at
    ) VALUES (?, ?, ?, 'EXTERNAL_WRITE', ?, 'pending', ?, ?)`,
    [id, input.taskId, input.ownerId, input.toolName, input.reason.slice(0, 500), now],
  );
  log.info("approval.requested", { approvalId: id, taskId: input.taskId, tool: input.toolName });
  const row = await getApproval(id);
  if (!row) throw new Error("approval_insert_failed");
  return row;
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  const row = await queryOne<{
    id: string;
    task_id: string | null;
    owner_id: number;
    risk_class: string;
    tool_name: string | null;
    status: string;
    reason: string;
    created_at: string;
    resolved_at: string | null;
  }>("SELECT * FROM agent_approvals WHERE id = ?", [id]);
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    ownerId: Number(row.owner_id),
    riskClass: row.risk_class,
    toolName: row.tool_name,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function listPendingApprovals(limit = 20): Promise<ApprovalRecord[]> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM agent_approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
    [Math.min(50, limit)],
  );
  const out: ApprovalRecord[] = [];
  for (const row of rows) {
    const full = await getApproval(row.id);
    if (full) out.push(full);
  }
  return out;
}

/**
 * Approve resumes the task as completed bookkeeping: no external adapter is
 * invoked, and a trade tool cannot be approved into an order.
 * Reject cancels the task.
 */
export async function resolveApproval(input: {
  approvalId: string;
  ownerId: number;
  decision: "approved" | "rejected";
}): Promise<{ approval: ApprovalRecord; taskStatus: string }> {
  const approval = await getApproval(input.approvalId);
  if (!approval || approval.ownerId !== input.ownerId) throw new Error("approval_missing");
  if (approval.status !== "pending") throw new Error("approval_not_pending");
  if (approval.toolName && isTradeExecutionTool(approval.toolName)) {
    throw new TradeBoundaryError(approval.toolName);
  }
  const now = nowIso();
  if (input.decision === "rejected") {
    if (approval.taskId) await cancelTask(approval.taskId, "approval_rejected");
    await execute(
      "UPDATE agent_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?",
      [now, approval.id],
    );
  } else {
    if (approval.taskId) {
      await execute(
        `UPDATE agent_tasks
         SET status = 'completed', error = NULL, updated_at = ?, finished_at = ?,
             output_json = ?, lease_owner = NULL, lease_until = NULL
         WHERE id = ? AND status = 'waiting_for_approval'`,
        [
          now,
          now,
          JSON.stringify({
            summary: `Owner approved ${approval.toolName ?? "external write"}. No external adapter ran.`,
            externalWrite: false,
          }),
          approval.taskId,
        ],
      );
    }
    await execute(
      "UPDATE agent_approvals SET status = 'approved', resolved_at = ? WHERE id = ?",
      [now, approval.id],
    );
  }
  const next = await getApproval(approval.id);
  if (!next) throw new Error("approval_missing");
  const task = approval.taskId ? await getTask(approval.taskId) : null;
  log.info("approval.resolved", { approvalId: approval.id, decision: input.decision, taskStatus: task?.status ?? null });
  return { approval: next, taskStatus: task?.status ?? "missing" };
}
