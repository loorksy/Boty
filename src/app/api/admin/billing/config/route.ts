import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { requireAdminWith } from "@/lib/adminRoles";
import { initDb } from "@/lib/db";
import { billingRetired } from "@/lib/billing/retired";
import {
  SPEND_OPS,
  getBillingPlan,
  getCreditPrice,
  getCurrentPlanPrice,
  listOffers,
  listTopupPacks,
} from "@/lib/billing/planConfig";
import { paymentStatus } from "@/lib/billing/paymentProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Billing v3 admin configuration — every priced or bounded number the
 * platform uses, readable and writable HERE and nowhere in code. The plan
 * price itself is written through setPlanPrice (immutable rows), never
 * edited in place.
 */
export async function GET() {
  try {
    await requireAdminWith("billing_write");
    await initDb();
    const [plan, price, packs, offers, payments] = await Promise.all([
      getBillingPlan(),
      getCurrentPlanPrice(),
      listTopupPacks(true),
      listOffers(),
      paymentStatus(),
    ]);
    const prices: Record<string, number> = {};
    for (const op of SPEND_OPS) prices[op] = await getCreditPrice(op);
    return NextResponse.json({
      ok: true,
      plan,
      current_price: price,
      credit_prices: prices,
      packs,
      offers,
      payments_configured: payments.configured,
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT() {
  try {
    await requireAdminWith("billing_write");
    return billingRetired();
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
