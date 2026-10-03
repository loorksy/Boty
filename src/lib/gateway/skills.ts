/**
 * Skills are loaded explicitly for a role. A sub-agent never receives the
 * full catalog, and a missing required skill fails the task.
 */
import { createDefaultAgentSkillRegistry } from "@/lib/agent/skills/defaultRegistry";
import type { AgentSkillRegistry } from "@/lib/agent/skills/skillRegistry";
import type { SubAgentRole } from "./roles";

export interface SkillUse {
  name: string;
  version: string;
  description: string;
}

export class SkillUnavailableError extends Error {
  readonly code = "SKILL_UNAVAILABLE";
  constructor(role: string, missing: string[]) {
    super(`Required skill unavailable for ${role}: ${missing.join(", ")}`);
    this.name = "SkillUnavailableError";
  }
}

/** Required skills are few and role-specific. Empty means the role is deterministic. */
export const ROLE_SKILLS: Record<SubAgentRole, { required: string[]; optional: string[] }> = {
  supervisor: { required: [], optional: [] },
  market_watcher: { required: [], optional: [] },
  structure_analyst: { required: ["pattern-atlas"], optional: ["trading-strategies"] },
  liquidity_analyst: { required: ["pattern-atlas"], optional: [] },
  macro_news_analyst: { required: [], optional: ["trading-strategies"] },
  risk_reviewer: { required: ["aichart-trading"], optional: [] },
  research_agent: { required: ["trading-strategies"], optional: ["pattern-atlas"] },
  memory_curator: { required: [], optional: [] },
  system_guardian: { required: [], optional: [] },
};

export function selectSkillsForRole(
  role: SubAgentRole,
  registry: AgentSkillRegistry = createDefaultAgentSkillRegistry(),
): { used: SkillUse[]; missing: string[] } {
  const spec = ROLE_SKILLS[role];
  const available = new Map(
    registry.discover().map((descriptor) => [descriptor.metadata.name, descriptor]),
  );
  const missing = spec.required.filter((name) => !available.has(name));
  if (missing.length) throw new SkillUnavailableError(role, missing);
  const names = [...spec.required, ...spec.optional.filter((name) => available.has(name))];
  const used = names.map((name) => {
    const descriptor = available.get(name)!;
    return {
      name: descriptor.metadata.name,
      version: descriptor.metadata.version,
      description: descriptor.metadata.description.slice(0, 240),
    };
  });
  return { used, missing: [] };
}
