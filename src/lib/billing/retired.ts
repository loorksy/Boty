import { NextResponse } from "next/server";

/** Customer SaaS billing is retired. Owner cost telemetry lives on the gateway. */
export function billingRetired() {
  return NextResponse.json(
    {
      error: "Customer billing is retired. Operator cost telemetry is on /api/gateway/costs.",
      code: "BILLING_RETIRED",
    },
    { status: 410 },
  );
}
