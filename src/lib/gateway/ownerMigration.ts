/**
 * Single-owner migration. Dry-run discovers unique conflicts and writes nothing.
 * Apply refuses before the first write when a conflict cannot be merged, and
 * otherwise promotes the owner, remaps user_id rows, and optionally suspends
 * other accounts inside one transaction.
 */
import { query, queryOne, transaction } from "@/lib/db";

export interface MigrationUser {
  id: number;
  email: string;
  role: string;
  status: string;
  telegram_id: number | null;
}

export interface UniqueConflict {
  table: string;
  key: string;
  rows: number;
}

export interface MigrationPlan {
  owner: MigrationUser;
  users: MigrationUser[];
  tables: Array<{ table: string; rows: number }>;
  conflicts: UniqueConflict[];
  telegramMove: { fromUserId: number; telegramId: number } | null;
  telegramConflicts: Array<{ userId: number; telegramId: number; email: string }>;
}

export class MigrationConflictError extends Error {
  readonly conflicts: UniqueConflict[];
  constructor(conflicts: UniqueConflict[]) {
    super(`Refusing to migrate. ${conflicts.length} unique conflict(s) would leave the database half-updated.`);
    this.name = "MigrationConflictError";
    this.conflicts = conflicts;
  }
}

function safeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  return name;
}

async function tablesWithUserId(): Promise<string[]> {
  if (process.env.DATABASE_URL) {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'user_id'`,
    );
    return rows.map((row) => row.table_name).filter((name) => name !== "users");
  }
  const tables = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const found: string[] = [];
  for (const table of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(table.name)) continue;
    const cols = await query<{ name: string }>(`PRAGMA table_info(${table.name})`);
    if (cols.some((col) => col.name === "user_id")) found.push(table.name);
  }
  return found.filter((name) => name !== "users");
}

async function uniqueKeyColumns(table: string): Promise<string[][]> {
  const name = safeIdent(table);
  if (process.env.DATABASE_URL) {
    const rows = await query<{ cols: string }>(
      `SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public' AND tc.table_name = ? AND tc.constraint_type = 'UNIQUE'
       GROUP BY tc.constraint_name`,
      [name],
    );
    return rows
      .map((row) => row.cols.split(",").filter(Boolean))
      .filter((cols) => cols.includes("user_id"));
  }
  const indexes = await query<{ name: string; unique: number }>(`PRAGMA index_list(${name})`);
  const keys: string[][] = [];
  for (const index of indexes) {
    if (!index.unique) continue;
    const cols = await query<{ name: string }>(`PRAGMA index_info(${safeIdent(index.name)})`);
    const names = cols.map((col) => col.name).filter(Boolean);
    if (names.includes("user_id")) keys.push(names);
  }
  return keys;
}

async function conflictsFor(table: string, ownerId: number): Promise<UniqueConflict[]> {
  const name = safeIdent(table);
  const indexes = await uniqueKeyColumns(name);
  const found: UniqueConflict[] = [];
  for (const columns of indexes) {
    const others = columns.filter((column) => column !== "user_id").map(safeIdent);
    if (others.length === 0) {
      const row = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${name} WHERE user_id IS NOT NULL`,
      );
      if (Number(row?.n ?? 0) > 1) {
        found.push({ table: name, key: "user_id", rows: Number(row?.n ?? 0) });
      }
      continue;
    }
    const projected = others.join(", ");
    const rows = await query<Record<string, unknown>>(
      `SELECT ${projected}, COUNT(*) AS n FROM (
         SELECT ${projected} FROM ${name} WHERE user_id = ?
         UNION ALL
         SELECT ${projected} FROM ${name} WHERE user_id IS NOT NULL AND user_id != ?
       ) keys
       WHERE ${others.map((column) => `${column} IS NOT NULL`).join(" AND ")}
       GROUP BY ${projected}
       HAVING COUNT(*) > 1`,
      [ownerId, ownerId],
    );
    for (const row of rows) {
      const key = others.map((column) => `${column}=${String(row[column])}`).join(",");
      found.push({ table: name, key, rows: Number(row.n ?? 0) });
    }
  }
  return found;
}

export async function loadMigrationUsers(): Promise<MigrationUser[]> {
  return query<MigrationUser>(
    "SELECT id, email, role, status, telegram_id FROM users ORDER BY id ASC",
  );
}

export function chooseOwner(
  users: MigrationUser[],
  input: { ownerId?: number | null; ownerEmail?: string | null },
): MigrationUser | null {
  if (input.ownerId) return users.find((user) => user.id === input.ownerId) ?? null;
  const email = (input.ownerEmail || "").trim().toLowerCase();
  if (email) return users.find((user) => user.email.toLowerCase() === email) ?? null;
  if (users.length === 1) return users[0] ?? null;
  return null;
}

export async function inspectOwnerMigration(input: {
  ownerId?: number | null;
  ownerEmail?: string | null;
}): Promise<MigrationPlan> {
  const users = await loadMigrationUsers();
  const owner = chooseOwner(users, input);
  if (!owner) {
    throw new Error("owner_not_selected");
  }
  const others = users.filter((user) => user.id !== owner.id);
  const telegramHolders = others.filter((user) => user.telegram_id != null);
  const telegramMove =
    owner.telegram_id == null && telegramHolders.length === 1
      ? { fromUserId: telegramHolders[0]!.id, telegramId: Number(telegramHolders[0]!.telegram_id) }
      : null;
  const tables = await tablesWithUserId();
  const plans: Array<{ table: string; rows: number }> = [];
  const conflicts: UniqueConflict[] = [];
  for (const table of tables) {
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${safeIdent(table)} WHERE user_id IS NOT NULL AND user_id != ?`,
      [owner.id],
    );
    const rows = Number(row?.n ?? 0);
    if (rows > 0) plans.push({ table, rows });
    conflicts.push(...(await conflictsFor(table, owner.id)));
  }
  return {
    owner,
    users,
    tables: plans,
    conflicts,
    telegramMove,
    telegramConflicts: telegramHolders.map((user) => ({
      userId: user.id,
      telegramId: Number(user.telegram_id),
      email: user.email,
    })),
  };
}

export async function applyOwnerMigration(input: {
  ownerId?: number | null;
  ownerEmail?: string | null;
  retireOthers?: boolean;
}): Promise<MigrationPlan> {
  const plan = await inspectOwnerMigration(input);
  if (plan.conflicts.length > 0) throw new MigrationConflictError(plan.conflicts);
  await transaction(async (helpers) => {
    await helpers.execute("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", [plan.owner.id]);
    if (input.retireOthers) {
      await helpers.execute("UPDATE users SET status = 'suspended' WHERE id != ?", [plan.owner.id]);
    }
    if (plan.telegramMove) {
      await helpers.execute("UPDATE users SET telegram_id = NULL WHERE id = ?", [plan.telegramMove.fromUserId]);
      await helpers.execute("UPDATE users SET telegram_id = ? WHERE id = ?", [
        plan.telegramMove.telegramId,
        plan.owner.id,
      ]);
    }
    for (const table of plan.tables) {
      await helpers.execute(
        `UPDATE ${safeIdent(table.table)} SET user_id = ? WHERE user_id IS NOT NULL AND user_id != ?`,
        [plan.owner.id, plan.owner.id],
      );
    }
  });
  return plan;
}

export async function countUserRows(table: string, userId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${safeIdent(table)} WHERE user_id = ?`,
    [userId],
  );
  return Number(row?.n ?? 0);
}
