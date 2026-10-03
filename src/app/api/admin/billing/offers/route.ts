import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { requireAdminWith } from "@/lib/adminRoles";
import { initDb } from "@/lib/db";
import { billingRetired } from "@/lib/billing/retired";
import { listOffers } from "@/lib/billing/planConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Billing v3: offers. An offer applies ONLY to checkouts created inside its
 * window — evaluated at session-create time, no retroactivity, no effect
 * once ended even while the row exists. Deactivation is immediate.
 */
export async function GET() {
  try {
    await requireAdminWith("billing_write");
    await initDb();
    return NextResponse.json({ ok: true, offers: await listOffers() });
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
