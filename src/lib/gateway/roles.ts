/**
 * First-party sub-agent roles. Each role points at an existing specialist
 * module. The gateway wraps those modules; it does not reimplement them.
 */
export const SUBAGENT_ROLES = [
  "supervisor",
  "market_watcher",
  "structure_analyst",
  "liquidity_analyst",
  "macro_news_analyst",
  "risk_reviewer",
  "research_agent",
  "memory_curator",
  "system_guardian",
] as const;

export type SubAgentRole = (typeof SUBAGENT_ROLES)[number];

export function isSubAgentRole(value: string): value is SubAgentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(value);
}

/** Existing specialist modules. Importers of the order path are not in this map. */
export const ROLE_SPECIALIST_MODULE: Record<SubAgentRole, string | null> = {
  supervisor: "src/lib/agent/orchestrator.ts",
  market_watcher: "src/lib/recommendations/recommendationTracker.ts",
  structure_analyst: "src/lib/agent/agents/structureAgent.ts",
  liquidity_analyst: "src/lib/agent/agents/liquidityAgent.ts",
  macro_news_analyst: "src/lib/agent/agents/newsMacroAgent.ts",
  risk_reviewer: "src/lib/agent/agents/riskAgent.ts",
  research_agent: "src/lib/agent/researchEvidence.ts",
  memory_curator: "src/lib/agent/agentMemory.ts",
  system_guardian: "src/lib/gateway/status.ts",
};

export const ROLE_TOOLS: Record<SubAgentRole, readonly string[]> = {
  supervisor: ["create_goal", "delegate", "read_tasks", "read_memory"],
  market_watcher: ["read_candles", "read_recommendations", "read_session"],
  structure_analyst: ["read_candles", "analyze_structure"],
  liquidity_analyst: ["read_candles", "analyze_liquidity"],
  macro_news_analyst: ["read_news", "read_calendar"],
  risk_reviewer: ["read_plan", "validate_geometry"],
  research_agent: ["read_history", "read_candles"],
  memory_curator: ["read_memory", "write_memory"],
  system_guardian: ["read_gateway_health"],
};

export const SUBAGENT_LIMITS = {
  maxDepth: 1,
  maxChildren: 4,
  maxConcurrent: 6,
  timeoutMs: 20_000,
  deadlineMs: 60_000,
  maxTokens: 4_000,
} as const;
