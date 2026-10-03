/**
 * Convert an existing installation to the single owner.
 *
 *   npx tsx scripts/migrate-single-owner.ts                 # dry-run
 *   npx tsx scripts/migrate-single-owner.ts --owner-email you@example.com --apply
 *   npx tsx scripts/migrate-single-owner.ts --owner-id 1 --apply --retire-others
 *
 * Dry-run is the default. The script never deletes users or history.
 * When more than one user exists, an explicit --owner-id or --owner-email is required.
 * --retire-others sets every other account to suspended. It does not remove rows.
 */
import { execute, initDb, query, queryOne, transaction } from "../src/lib/db";

interface UserRow {
  id: number;
  email: string;
  role: string;
  status: string;
  telegram_id: number | null;
}

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const retireOthers = args.has("--retire-others");

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
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

async function main(): Promise<void> {
  await initDb();
  const users = await query<UserRow>(
    "SELECT id, email, role, status, telegram_id FROM users ORDER BY id ASC",
  );
  console.log(`users=${users.length} mode=${apply ? "apply" : "dry-run"}`);
  for (const user of users) {
    console.log(
      `  id=${user.id} role=${user.role} status=${user.status} email=${user.email} telegram=${user.telegram_id ?? ""}`,
    );
  }
  if (users.length === 0) {
    console.error("No users. Bootstrap ADMIN_EMAIL and ADMIN_PASSWORD, then re-run.");
    process.exit(1);
  }

  const ownerIdArg = flagValue("--owner-id");
  const ownerEmailArg = (flagValue("--owner-email") || "").trim().toLowerCase();
  let owner: UserRow | undefined;
  if (ownerIdArg) {
    owner = users.find((user) => user.id === Number(ownerIdArg));
  } else if (ownerEmailArg) {
    owner = users.find((user) => user.email.toLowerCase() === ownerEmailArg);
  } else if (users.length === 1) {
    owner = users[0];
  }
  if (!owner) {
    const suggested = users.find((user) => user.role === "admin") ?? users[0];
    console.error("Multiple users. Refusing to guess.");
    console.error(`Suggested owner id=${suggested?.id} email=${suggested?.email}`);
    console.error("Re-run with --owner-id or --owner-email. Nothing was written.");
    process.exit(2);
  }
  console.log(`owner id=${owner.id} email=${owner.email}`);

  const others = users.filter((user) => user.id !== owner.id);
  const telegramHolders = others.filter((user) => user.telegram_id != null);
  if (telegramHolders.length > 0) {
    console.log("telegram bindings on non-owner accounts:");
    for (const user of telegramHolders) {
      console.log(`  conflict user=${user.id} telegram_id=${user.telegram_id} email=${user.email}`);
    }
    if (owner.telegram_id != null) {
      console.log("owner already has a telegram_id; other bindings will not be overwritten.");
    } else if (telegramHolders.length === 1) {
      console.log("the single non-owner telegram id can move onto the owner when --apply is set.");
    } else {
      console.log("more than one telegram id; none will be copied. Bind the owner explicitly.");
    }
  }

  const tables = await tablesWithUserId();
  const plans: Array<{ table: string; rows: number }> = [];
  for (const table of tables) {
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NOT NULL AND user_id != ?`,
      [owner.id],
    );
    const rows = Number(row?.n ?? 0);
    if (rows > 0) {
      plans.push({ table, rows });
      console.log(`remap ${table}: ${rows} row(s) -> owner ${owner.id}`);
    }
  }
  if (!apply) {
    console.log("dry-run complete. Re-run with --apply to write.");
    return;
  }

  await transaction(async (helpers) => {
    await helpers.execute(
      "UPDATE users SET role = 'admin', status = 'active' WHERE id = ?",
      [owner.id],
    );
    if (retireOthers) {
      await helpers.execute("UPDATE users SET status = 'suspended' WHERE id != ?", [owner.id]);
    }
    if (owner.telegram_id == null && telegramHolders.length === 1) {
      const donor = telegramHolders[0]!;
      await helpers.execute("UPDATE users SET telegram_id = NULL WHERE id = ?", [donor.id]);
      await helpers.execute("UPDATE users SET telegram_id = ? WHERE id = ?", [
        donor.telegram_id,
        owner.id,
      ]);
      console.log(`moved telegram_id ${donor.telegram_id} from user ${donor.id} to owner ${owner.id}`);
    }
  });

  for (const plan of plans) {
    try {
      await execute(`UPDATE ${plan.table} SET user_id = ? WHERE user_id IS NOT NULL AND user_id != ?`, [
        owner.id,
        owner.id,
      ]);
      console.log(`updated ${plan.table}`);
    } catch (err) {
      console.error(
        `conflict ${plan.table}: ${err instanceof Error ? err.message : String(err)}. Rows were left in place.`,
      );
    }
  }
  console.log("apply complete. Users were not deleted.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
