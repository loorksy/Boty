import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { requireAdminWith } from "@/lib/adminRoles";
import { initDb } from "@/lib/db";
import { billingRetired } from "@/lib/billing/retired";
import { listTopupPacks } from "@/lib/billing/planConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Billing v3: top-up pack CRUD. Packs archive, never vanish — an open
 *  checkout carries its own pinned terms and history keeps its reference. */
export async function GET() {
  try {
    await requireAdminWith("billing_write");
    await initDb();
    return NextResponse.json({ ok: true, packs: await listTopupPacks(true) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST() {
  try {
    await requireAdminWith("billing_write");
    return billingRetired();
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH() {
  try {
    await requireAdminWith("billing_write");
    return billingRetired();
  } catch (err) {
    return handleError(err);
  }
}
