/**
 * Gateway tables. SQL is SQLite-shaped; Postgres goes through adaptSql.
 * Statements are executed with the raw backend helpers so schema setup can
 * run from inside initDb without re-entering it.
 */
import { adaptSql } from "@/lib/db/sql";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_goals (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT,
    latest_findings TEXT,
    last_action TEXT,
    next_check_at TEXT,
    fingerprint TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_goals_owner_status ON agent_goals(owner_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_goals_next_check ON agent_goals(status, next_check_at)`,
  `CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    goal_id TEXT,
    parent_task_id TEXT,
    role TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_owner TEXT,
    lease_until TEXT,
    deadline_at TEXT,
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_idem ON agent_tasks(idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, lease_until)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_tasks_goal ON agent_tasks(goal_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_tasks_owner ON agent_tasks(owner_id, status)`,
  `CREATE TABLE IF NOT EXISTS agent_task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    parent_run_id TEXT,
    subagent_id TEXT,
    status TEXT NOT NULL,
    summary TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_task_runs_task ON agent_task_runs(task_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS agent_schedules (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    cadence_ms INTEGER NOT NULL,
    next_run_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_schedules_goal ON agent_schedules(goal_id, enabled)`,
  `CREATE TABLE IF NOT EXISTS agent_approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    owner_id INTEGER NOT NULL,
    risk_class TEXT NOT NULL,
    tool_name TEXT,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON agent_approvals(owner_id, status)`,
  `CREATE TABLE IF NOT EXISTS agent_subagents (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    parent_run_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    objective TEXT NOT NULL,
    allowed_tools_json TEXT NOT NULL DEFAULT '[]',
    allowed_skills_json TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_subagents_parent ON agent_subagents(parent_run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_subagents_status ON agent_subagents(status)`,
  `CREATE TABLE IF NOT EXISTS gateway_notifications (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    reason TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    goal_id TEXT,
    task_id TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_notifications_dedupe ON gateway_notifications(dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_notifications_recent ON gateway_notifications(owner_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS gateway_event_dedupe (
    dedupe_key TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

export async function ensureGatewaySchema(): Promise<void> {
  const { getDbBackend } = await import("@/lib/db");
  const backend = getDbBackend();
  if (backend === "postgres") {
    const { pgExecute } = await import("@/lib/db/pg");
    for (const statement of STATEMENTS) {
      await pgExecute(adaptSql(statement, "postgres"));
    }
    return;
  }
  const { sqliteExecute } = await import("@/lib/db/sqlite");
  for (const statement of STATEMENTS) {
    await sqliteExecute(statement);
  }
}
