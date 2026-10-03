import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { buildGatewayStatus } from "@/lib/gateway/status";
import { requireOwner } from "@/lib/ownerIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOwner();
    return NextResponse.json(await buildGatewayStatus());
  } catch (err) {
    return handleError(err);
  }
}
