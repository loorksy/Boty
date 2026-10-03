/**
 * Convert an existing installation to the single owner.
 *
 *   npx tsx scripts/migrate-single-owner.ts                 # dry-run
 *   npx tsx scripts/migrate-single-owner.ts --owner-email you@example.com --apply
 *   npx tsx scripts/migrate-single-owner.ts --owner-id 1 --apply --retire-others
 *
 * Dry-run is the default and never writes. Unique conflicts are printed before
 * any write. --apply refuses with exit 3 when a conflict cannot be merged, and
 * otherwise commits owner promotion, row remaps, and optional suspension in
 * one transaction. A failed apply does not print success.
 */
import { initDb } from "../src/lib/db";
import {
  MigrationConflictError,
  applyOwnerMigration,
  chooseOwner,
  inspectOwnerMigration,
  loadMigrationUsers,
} from "../src/lib/gateway/ownerMigration";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const retireOthers = args.has("--retire-others");

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  await initDb();
  const users = await loadMigrationUsers();
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
  const owner = chooseOwner(users, {
    ownerId: ownerIdArg ? Number(ownerIdArg) : null,
    ownerEmail: ownerEmailArg || null,
  });
  if (!owner) {
    const suggested = users.find((user) => user.role === "admin") ?? users[0];
    console.error("Multiple users. Refusing to guess.");
    console.error(`Suggested owner id=${suggested?.id} email=${suggested?.email}`);
    console.error("Re-run with --owner-id or --owner-email. Nothing was written.");
    process.exit(2);
  }
  const plan = await inspectOwnerMigration({
    ownerId: owner.id,
    ownerEmail: ownerEmailArg || null,
  });
  console.log(`owner id=${plan.owner.id} email=${plan.owner.email}`);
  for (const conflict of plan.telegramConflicts) {
    console.log(`  telegram conflict user=${conflict.userId} telegram_id=${conflict.telegramId} email=${conflict.email}`);
  }
  if (plan.telegramMove) {
    console.log(
      `telegram_id ${plan.telegramMove.telegramId} can move from user ${plan.telegramMove.fromUserId} to the owner.`,
    );
  }
  for (const table of plan.tables) {
    console.log(`remap ${table.table}: ${table.rows} row(s) -> owner ${plan.owner.id}`);
  }
  for (const conflict of plan.conflicts) {
    console.error(`CONFLICT ${conflict.table} key=${conflict.key} rows=${conflict.rows}`);
  }
  if (!apply) {
    if (plan.conflicts.length > 0) {
      console.error("dry-run found conflicts. --apply will refuse before writing.");
      process.exit(3);
    }
    console.log("dry-run complete. Re-run with --apply to write.");
    return;
  }
  try {
    await applyOwnerMigration({
      ownerId: plan.owner.id,
      retireOthers,
    });
  } catch (err) {
    if (err instanceof MigrationConflictError) {
      for (const conflict of err.conflicts) {
        console.error(`CONFLICT ${conflict.table} key=${conflict.key} rows=${conflict.rows}`);
      }
      console.error("apply refused before any write.");
      process.exit(3);
    }
    console.error("apply failed. The transaction was rolled back.");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log("apply complete. Users were not deleted.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
