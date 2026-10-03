import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { setGatewayPaused } from "@/lib/gateway/runtime";
import { requireOwner } from "@/lib/ownerIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ paused: z.boolean() });

export async function POST(req: Request) {
  try {
    await requireOwner();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    await setGatewayPaused(parsed.data.paused);
    return NextResponse.json({ paused: parsed.data.paused });
  } catch (err) {
    return handleError(err);
  }
}
