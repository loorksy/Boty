import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { listPendingApprovals, resolveApproval } from "@/lib/gateway/approvals";
import { requireOwner } from "@/lib/ownerIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOwner();
    return NextResponse.json({ approvals: await listPendingApprovals() });
  } catch (err) {
    return handleError(err);
  }
}

const schema = z.object({
  id: z.string().min(8).max(80),
  action: z.enum(["approve", "reject"]),
});

export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    const result = await resolveApproval({
      approvalId: parsed.data.id,
      ownerId: owner.id,
      decision: parsed.data.action === "approve" ? "approved" : "rejected",
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleError(err);
  }
}
