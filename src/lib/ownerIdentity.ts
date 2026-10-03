/**
 * Canonical owner of this private agent.
 *
 * There is one human operator. Every runtime path that used to accept an
 * arbitrary platform user resolves here. `user_id` columns may remain as the
 * owner's foreign key; nothing in the request path may select a second user.
 */
import { ApiError } from "./api";
import { initDb, queryOne, execute } from "./db";
import type { PublicUser, UserRow } from "./types";
import { userRowToPublicUser } from "./userSelect";

export class OwnerAccessError extends Error {
  readonly status = 403;
  readonly code = "OWNER_ONLY";
  constructor(message = "This private agent has one owner.") {
    super(message);
    this.name = "OwnerAccessError";
  }
}

export class OwnerMissingError extends Error {
  readonly status = 503;
  constructor(message = "No owner account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD.") {
    super(message);
    this.name = "OwnerMissingError";
  }
}

let cachedOwnerId: number | null = null;

/** Test seam. Production never needs to forget the owner mid-process. */
export function resetOwnerCacheForTests(): void {
  cachedOwnerId = null;
}

function envOwnerId(): number | null {
  const fromEnv = Number(process.env.AICHART_AGENT_USER_ID);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

function envOwnerEmail(): string | null {
  const email = (process.env.LONORA_OWNER_EMAIL || process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  return email || null;
}

/**
 * Resolve the owner id without creating or mutating users.
 * Order: explicit id, explicit email, first admin, then the earliest user.
 */
export async function getOwnerId(): Promise<number | null> {
  if (cachedOwnerId !== null) return cachedOwnerId;
  await initDb();

  const pinned = envOwnerId();
  if (pinned) {
    const row = await queryOne<{ id: number }>("SELECT id FROM users WHERE id = ?", [pinned]);
    if (row) {
      cachedOwnerId = Number(row.id);
      return cachedOwnerId;
    }
  }

  const email = envOwnerEmail();
  if (email) {
    const row = await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE email = ? ORDER BY id ASC LIMIT 1",
      [email],
    );
    if (row) {
      cachedOwnerId = Number(row.id);
      return cachedOwnerId;
    }
  }

  const admin = await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1",
  );
  if (admin) {
    cachedOwnerId = Number(admin.id);
    return cachedOwnerId;
  }

  const first = await queryOne<{ id: number }>("SELECT id FROM users ORDER BY id ASC LIMIT 1");
  if (first) {
    cachedOwnerId = Number(first.id);
    return cachedOwnerId;
  }
  return null;
}

export async function getOwner(): Promise<PublicUser | null> {
  const id = await getOwnerId();
  if (id == null) return null;
  const row = await queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return row ? userRowToPublicUser(row) : null;
}

/**
 * Promote the canonical owner to an active admin. Does not create a second
 * account and does not touch any other row.
 */
export async function ensureOwner(): Promise<PublicUser> {
  const id = await getOwnerId();
  if (id == null) throw new OwnerMissingError();
  await execute(
    "UPDATE users SET role = 'admin', status = 'active' WHERE id = ?",
    [id],
  );
  const { ensureUserDefaults } = await import("./store");
  await ensureUserDefaults(id);
  const owner = await getOwner();
  if (!owner) throw new OwnerMissingError();
  return owner;
}

export async function assertOwnerUserId(userId: number): Promise<void> {
  const ownerId = await getOwnerId();
  if (ownerId == null || userId !== ownerId) throw new OwnerAccessError();
}

export async function requireOwner(): Promise<PublicUser> {
  const { getCurrentUser } = await import("./auth");
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "Sign in as the owner.");
  await assertOwnerUserId(user.id);
  return user;
}
