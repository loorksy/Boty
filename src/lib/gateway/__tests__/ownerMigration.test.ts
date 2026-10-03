import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "lonora-migrate-"));
const dbPath = path.join(dir, "migrate.db");
process.env.DB_PATH = dbPath;
process.env.ENCRYPTION_KEY = "2".repeat(64);
process.env.APP_SECRET = "migrate-test-secret-value";
delete process.env.DATABASE_URL;
delete process.env.AICHART_AGENT_USER_ID;
delete process.env.LONORA_OWNER_EMAIL;
delete process.env.ADMIN_EMAIL;

const repo = path.join(import.meta.dirname, "..", "..", "..", "..");

let db: typeof import("@/lib/db");
let auth: typeof import("@/lib/auth");
let owner: typeof import("@/lib/ownerIdentity");
let migration: typeof import("@/lib/gateway/ownerMigration");

function runMigrate(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/migrate-single-owner.ts", ...args],
    {
      cwd: repo,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        DATABASE_URL: "",
      },
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

before(async () => {
  db = await import("@/lib/db");
  await db.initDb();
  auth = await import("@/lib/auth");
  owner = await import("@/lib/ownerIdentity");
  migration = await import("@/lib/gateway/ownerMigration");
});

describe("single-owner migration", () => {
  it("adopts one user, refuses a guess, and rolls back a unique conflict", async () => {
    const onlyId = await db.insertReturningId(
      "INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, 'user', 'active')",
      ["only@example.com", auth.hashPassword("only-pass-1")],
    );
    owner.resetOwnerCacheForTests();
    const only = await owner.resolveOwner();
    assert.equal(only.ok, true);
    if (only.ok) {
      assert.equal(only.id, onlyId);
      assert.equal(only.source, "only_user");
    }

    const otherId = await db.insertReturningId(
      "INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, 'admin', 'active')",
      ["other@example.com", auth.hashPassword("other-pass-1")],
    );
    owner.resetOwnerCacheForTests();
    const ambiguous = await owner.resolveOwner();
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.equal(ambiguous.reason, "ambiguous");
    await assert.rejects(() => owner.ensureOwner(), owner.OwnerAmbiguousError);

    process.env.AICHART_AGENT_USER_ID = String(onlyId);
    owner.resetOwnerCacheForTests();
    const pinned = await owner.resolveOwner();
    assert.equal(pinned.ok, true);
    if (pinned.ok) assert.equal(pinned.source, "id");
    delete process.env.AICHART_AGENT_USER_ID;
    owner.resetOwnerCacheForTests();

    await db.execute(
      "INSERT INTO user_agent_skills (user_id, name, content) VALUES (?, 'watch', 'owner skill')",
      [onlyId],
    );
    await db.execute(
      "INSERT INTO user_agent_skills (user_id, name, content) VALUES (?, 'watch', 'other skill')",
      [otherId],
    );
    await db.execute(
      "INSERT INTO agent_audit_logs (user_id, request_id, summary) VALUES (?, 'req-migrate', 'keep me')",
      [otherId],
    );

    await assert.rejects(
      () => migration.applyOwnerMigration({ ownerId: onlyId, retireOthers: true }),
      (err: unknown) => err instanceof migration.MigrationConflictError && err.conflicts.length > 0,
    );
    const ownerRole = await db.queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [onlyId]);
    const otherStatus = await db.queryOne<{ status: string }>("SELECT status FROM users WHERE id = ?", [otherId]);
    assert.equal(ownerRole?.role, "user");
    assert.equal(otherStatus?.status, "active");
    assert.equal(await migration.countUserRows("user_agent_skills", otherId), 1);
    assert.equal(await migration.countUserRows("agent_audit_logs", otherId), 1);
    assert.equal(await migration.countUserRows("agent_audit_logs", onlyId), 0);

    const refused = runMigrate(["--owner-id", String(onlyId), "--apply", "--retire-others"]);
    assert.equal(refused.status, 3);
    assert.match(refused.output, /apply refused before any write/);
    assert.equal(refused.output.includes("apply complete"), false);
    assert.equal(await migration.countUserRows("agent_audit_logs", otherId), 1);
    assert.equal((await db.queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [onlyId]))?.role, "user");

    await assert.rejects(
      () =>
        db.transaction(async (helpers) => {
          await helpers.execute("UPDATE users SET role = 'admin' WHERE id = ?", [onlyId]);
          throw new Error("important table failed");
        }),
      /important table failed/,
    );
    assert.equal((await db.queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [onlyId]))?.role, "user");

    await db.execute("DELETE FROM user_agent_skills WHERE user_id = ? AND name = 'watch'", [otherId]);
    const applied = runMigrate(["--owner-id", String(onlyId), "--apply", "--retire-others"]);
    assert.equal(applied.status, 0, applied.output);
    assert.match(applied.output, /apply complete/);
    assert.equal((await db.queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [onlyId]))?.role, "admin");
    assert.equal(
      (await db.queryOne<{ status: string }>("SELECT status FROM users WHERE id = ?", [otherId]))?.status,
      "suspended",
    );
    assert.equal(await migration.countUserRows("agent_audit_logs", onlyId), 1);
    assert.equal(await migration.countUserRows("agent_audit_logs", otherId), 0);
    assert.equal(await migration.countUserRows("user_agent_skills", onlyId), 1);
  });
});
