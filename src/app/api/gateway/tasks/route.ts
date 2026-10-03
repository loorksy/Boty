import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { cancelTask, listTasks } from "@/lib/gateway/tasks";
import { requireOwner } from "@/lib/ownerIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOwner();
    return NextResponse.json({ tasks: await listTasks({ limit: 50 }) });
  } catch (err) {
    return handleError(err);
  }
}

const schema = z.object({
  action: z.literal("cancel"),
  id: z.string().min(8).max(80),
});

export async function POST(req: Request) {
  try {
    await requireOwner();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    const task = await cancelTask(parsed.data.id, "owner_cancel");
    if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (err) {
    return handleError(err);
  }
}
