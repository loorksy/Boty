/**
 * Natural-language responsibilities. Mechanical slash commands are not goals.
 * A matching utterance becomes a persistent goal; the conversation still
 * continues so Lonora can confirm it in the owner's language.
 */
import { createGoal, type GoalKind } from "./goals";

/** Arabic hints live as escapes so this module stays free of literal Arabic. */
const AR_HINT = [
  "\u0631\u0627\u0642\u0628",
  "\u0645\u0631\u0627\u0642\u0628",
  "\u062c\u0644\u0633\u0629",
  "\u0646\u064a\u0648\u064a\u0648\u0631\u0643",
  "\u0644\u0646\u062f\u0646",
  "\u0625\u062d\u0627\u0637\u0629",
  "\u062a\u0642\u0631\u064a\u0631 \u0627\u0644\u0635\u0628\u0627\u062d",
  "\u062d\u062a\u0649 \u062a\u062a\u062d\u0642\u0642",
  "\u062d\u062a\u0649 \u062a\u0646\u062a\u0647\u064a",
].join("|");

const HINT = new RegExp(
  `\\b(monitor|watch|track|brief|briefing|alert me|tell me when|until it resolves|every morning)\\b|${AR_HINT}`,
  "i",
);

export interface InterpretedResponsibility {
  title: string;
  objective: string;
  kind: GoalKind;
  cadenceMs: number;
}

export function interpretResponsibility(text: string): InterpretedResponsibility | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;
  if (trimmed.length < 12) return null;
  if (!HINT.test(trimmed)) return null;
  let kind: GoalKind = "custom";
  let cadenceMs = 15 * 60 * 1000;
  const briefing = /brief|morning/i.test(trimmed) || /\u0625\u062d\u0627\u0637\u0629|\u0635\u0628\u0627\u062d/.test(trimmed);
  const recommendation = /recommendation/i.test(trimmed) || /\u062a\u0648\u0635\u064a\u0629/.test(trimmed);
  const research =
    /research|investigate|history/i.test(trimmed) ||
    /\u0644\u0645\u0627\u0630\u0627|\u0633\u0627\u0628\u0642/.test(trimmed);
  const monitor =
    /monitor|watch|track|session/i.test(trimmed) ||
    /\u0631\u0627\u0642\u0628|\u062c\u0644\u0633\u0629|\u0646\u064a\u0648\u064a\u0648\u0631\u0643|\u0644\u0646\u062f\u0646/.test(trimmed);
  if (briefing) {
    kind = "briefing";
    cadenceMs = 12 * 60 * 60 * 1000;
  } else if (recommendation) {
    kind = "watch_recommendation";
    cadenceMs = 5 * 60 * 1000;
  } else if (research) {
    kind = "research";
    cadenceMs = 60 * 60 * 1000;
  } else if (monitor) {
    kind = "monitor";
  }
  return {
    title: trimmed.slice(0, 80),
    objective: trimmed,
    kind,
    cadenceMs,
  };
}

export async function absorbResponsibilityUtterance(input: {
  ownerId: number;
  text: string;
}): Promise<{ created: boolean; goalId?: string }> {
  const interpreted = interpretResponsibility(input.text);
  if (!interpreted) return { created: false };
  const { queryOne } = await import("@/lib/db");
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM agent_goals
     WHERE owner_id = ? AND objective = ? AND status IN ('active', 'paused')
     ORDER BY created_at ASC LIMIT 1`,
    [input.ownerId, interpreted.objective],
  );
  if (existing) return { created: false, goalId: existing.id };
  const goal = await createGoal({
    ownerId: input.ownerId,
    title: interpreted.title,
    objective: interpreted.objective,
    kind: interpreted.kind,
    cadenceMs: interpreted.cadenceMs,
  });
  return { created: true, goalId: goal.id };
}
