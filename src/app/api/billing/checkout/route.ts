import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Customer checkout is retired. Provider spend stays on /api/gateway/costs. */
export async function POST() {
  return NextResponse.json(
    { error: "Customer billing is retired.", code: "BILLING_RETIRED" },
    { status: 410 },
  );
}
