import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "Customer billing is retired.", code: "BILLING_RETIRED" },
    { status: 410 },
  );
}
