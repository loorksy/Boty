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

export class OwnerAmbiguousError extends Error {
  readonly status = 503;
  readonly code = "OWNER_AMBIGUOUS";
  constructor(
    message = "Multiple accounts exist and no owner is pinned. Set AICHART_AGENT_USER_ID or LONORA_OWNER_EMAIL (ADMIN_EMAIL is accepted when it matches one account), or run npm run migrate:single-owner. The gateway will not guess.",
  ) {
    super(message);
    this.name = "OwnerAmbiguousError";
  }
}

export type OwnerResolution =
  | { ok: true; id: number; source: "id" | "email" | "admin_email" | "only_user" }
  | { ok: false; reason: "missing" | "ambiguous" };

let cachedOwnerId: number | null = null;

/** Test seam. Production never needs to forget the owner mid-process. */
export function resetOwnerCacheForTests(): void {
  cachedOwnerId = null;
}

function envOwnerId(): number | null {
  const fromEnv = Number(process.env.AICHART_AGENT_USER_ID);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

function envNamedEmail(name: "LONORA_OWNER_EMAIL" | "ADMIN_EMAIL"): string | null {
  const email = (process.env[name] || "").trim().toLowerCase();
  return email || null;
}

async function userCount(): Promise<number> {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return Number(row?.n ?? 0);
}

async function userIdByEmail(email: string): Promise<number | null> {
  const row = await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE lower(email) = ? ORDER BY id ASC LIMIT 1",
    [email],
  );
  return row ? Number(row.id) : null;
}

/**
 * Resolve the owner without creating users and without guessing.
 *
 * A pinned id, LONORA_OWNER_EMAIL, or ADMIN_EMAIL that matches one account
 * wins. A database with exactly one user adopts that user when nothing is
 * pinned. Several users and no matching pin is ambiguous: the gateway stops
 * instead of promoting the earliest admin.
 */
export async function resolveOwner(): Promise<OwnerResolution> {
  if (cachedOwnerId !== null) return { ok: true, id: cachedOwnerId, source: "id" };
  await initDb();
  const count = await userCount();
  if (count === 0) return { ok: false, reason: "missing" };

  const pinned = envOwnerId();
  if (pinned) {
    const row = await queryOne<{ id: number }>("SELECT id FROM users WHERE id = ?", [pinned]);
    if (!row) return { ok: false, reason: "ambiguous" };
    cachedOwnerId = Number(row.id);
    return { ok: true, id: cachedOwnerId, source: "id" };
  }

  const ownerEmail = envNamedEmail("LONORA_OWNER_EMAIL");
  if (ownerEmail) {
    const id = await userIdByEmail(ownerEmail);
    if (id == null) return { ok: false, reason: "ambiguous" };
    cachedOwnerId = id;
    return { ok: true, id, source: "email" };
  }

  const adminEmail = envNamedEmail("ADMIN_EMAIL");
  if (adminEmail) {
    const id = await userIdByEmail(adminEmail);
    if (id != null) {
      cachedOwnerId = id;
      return { ok: true, id, source: "admin_email" };
    }
    if (count > 1) return { ok: false, reason: "ambiguous" };
  }

  if (count === 1) {
    const only = await queryOne<{ id: number }>("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (!only) return { ok: false, reason: "missing" };
    cachedOwnerId = Number(only.id);
    return { ok: true, id: cachedOwnerId, source: "only_user" };
  }

  return { ok: false, reason: "ambiguous" };
}

/** Resolve the owner id without creating or mutating users. */
export async function getOwnerId(): Promise<number | null> {
  const resolved = await resolveOwner();
  return resolved.ok ? resolved.id : null;
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
  const resolved = await resolveOwner();
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") throw new OwnerAmbiguousError();
    throw new OwnerMissingError();
  }
  const id = resolved.id;
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
