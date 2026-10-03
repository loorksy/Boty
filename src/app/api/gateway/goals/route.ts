import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { cancelGoal, createGoal, listGoals, pauseGoal, resumeGoal } from "@/lib/gateway/goals";
import { absorbResponsibilityUtterance, interpretResponsibility } from "@/lib/gateway/responsibility";
import { requireOwner } from "@/lib/ownerIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOwner();
    return NextResponse.json({ goals: await listGoals() });
  } catch (err) {
    return handleError(err);
  }
}

const schema = z.object({
  objective: z.string().min(8).max(4000).optional(),
  action: z.enum(["pause", "resume", "cancel"]).optional(),
  id: z.string().min(8).max(80).optional(),
});

export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    if (parsed.data.action && parsed.data.id) {
      const goal =
        parsed.data.action === "pause"
          ? await pauseGoal(parsed.data.id)
          : parsed.data.action === "resume"
            ? await resumeGoal(parsed.data.id)
            : await cancelGoal(parsed.data.id);
      if (!goal) return NextResponse.json({ error: "goal not found" }, { status: 404 });
      return NextResponse.json({ goal });
    }
    const objective = parsed.data.objective?.trim();
    if (!objective) return NextResponse.json({ error: "objective required" }, { status: 400 });
    const absorbed = await absorbResponsibilityUtterance({ ownerId: owner.id, text: objective });
    if (absorbed.created && absorbed.goalId) {
      return NextResponse.json({ created: true, goalId: absorbed.goalId });
    }
    const interpreted = interpretResponsibility(objective);
    const goal = await createGoal({
      ownerId: owner.id,
      title: interpreted?.title ?? objective.slice(0, 80),
      objective,
      kind: interpreted?.kind ?? "custom",
      cadenceMs: interpreted?.cadenceMs,
    });
    return NextResponse.json({ created: true, goalId: goal.id });
  } catch (err) {
    return handleError(err);
  }
}
