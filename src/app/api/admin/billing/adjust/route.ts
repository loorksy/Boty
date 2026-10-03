import { billingRetired } from "@/lib/billing/retired";
import { handleError } from "@/lib/api";
import { requireAdminWith } from "@/lib/adminRoles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manual credit grants are retired with customer billing. */
export async function POST() {
  try {
    await requireAdminWith("billing_write");
    return billingRetired();
  } catch (err) {
    return handleError(err);
  }
}
