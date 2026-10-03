/**
 * Sub-agent roles call the specialists that already exist.
 * This module does not reimplement structure, liquidity, news, risk,
 * research, or memory. If a role cannot run, it fails by name.
 */
import type { AgentCandle } from "@/lib/agent/marketContext/detectors";
import type { AgentMarketContext } from "@/lib/agent/marketContext/buildAgentMarketContext";
import { UNAVAILABLE_COST } from "@/lib/agent/marketContext/costEvidence";
import type { AgentRunContext } from "@/lib/agent/types";
import { DATA_SYMBOL } from "@/lib/gold";
import { deepModelEnabled, runDeepModelAnalysis } from "./deepModel";
import type { SubAgentOutput, SubAgentRequest } from "./subagents";
import type { SkillUse } from "./skills";
import { SUBAGENT_LIMITS } from "./roles";

function silentContext(userId?: number): AgentRunContext {
  return {
    requestId: `gateway-${Date.now()}`,
    userId,
    emitActivity: () => {},
  };
}

function ownerFrom(request: SubAgentRequest): number | undefined {
  const raw = request.context?.ownerId;
  return typeof raw === "number" && raw > 0 ? raw : undefined;
}

function asCandles(value: unknown): AgentCandle[] | null {
  if (!Array.isArray(value) || value.length < 5) return null;
  const candles: AgentCandle[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const time = Number(row.time);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    candles.push({ time, open, high, low, close });
  }
  return candles;
}

async function marketFromCandles(candles: AgentCandle[]): Promise<AgentMarketContext> {
  const {
    calculateAtr,
    detectLiquidity,
    detectMajorLevels,
    detectMarketRegime,
    detectSupplyDemandZones,
  } = await import("@/lib/agent/marketContext/detectors");
  const price = candles[candles.length - 1]?.close ?? null;
  return {
    symbol: DATA_SYMBOL,
    interval: "15m",
    higherInterval: "1h",
    currentPrice: price,
    spread: null,
    costEvidence: UNAVAILABLE_COST,
    atr: calculateAtr(candles),
    marketRegime: detectMarketRegime(candles),
    dataQuality: {
      currentTfCount: candles.length,
      higherTfCount: 0,
      dailyCount: 0,
      sufficient: false,
      hasCriticalGaps: false,
      coverage: {
        sufficientForAnalysis: false,
        hasCriticalGaps: false,
      } as AgentMarketContext["dataQuality"]["coverage"],
      policyVersion: "gateway-candles",
    },
    freshness: {
      lastCandleTime: candles[candles.length - 1]?.time ?? null,
      ageMs: null,
      isFresh: false,
      reason: "candles supplied to the gateway task",
    },
    sync: {
      ok: false,
      reason: "gateway task candles are not a live broker sync",
      warehouseLastTime: null,
      liveLastTime: null,
      chartLastTime: null,
      warehouseClose: null,
      liveClose: null,
      chartClose: null,
      tolerance: { timeMs: 0, price: 0 },
    },
    marketOpen: true,
    currentTfCandles: candles,
    higherTfCandles: [],
    dailyCandles: [],
    visibleCandles: candles,
    majorLevels: detectMajorLevels(candles, []),
    liquidity: detectLiquidity(candles),
    zones: detectSupplyDemandZones(candles),
  };
}

function base(skills: SkillUse[]): Omit<SubAgentOutput, "status" | "summary" | "evidence" | "warnings" | "errors"> {
  return { artifacts: [], skills, tokens: 0, followUpSuggested: false };
}

function failed(
  skills: SkillUse[],
  code: string,
  summary: string,
  evidence: Array<Record<string, unknown>> = [],
): SubAgentOutput {
  return {
    ...base(skills),
    status: "failed",
    summary,
    evidence,
    warnings: [],
    errors: [code],
  };
}

async function maybeDeepen(
  request: SubAgentRequest,
  skills: SkillUse[],
  output: SubAgentOutput,
): Promise<SubAgentOutput> {
  if (output.status !== "completed") return output;
  if (request.context?.deepModel !== true) return output;
  if (!deepModelEnabled()) return output;
  const ownerId = ownerFrom(request);
  if (ownerId == null) {
    return failed(skills, "owner_missing", "Deep model was requested without an owner id.");
  }
  const budget = request.tokenBudget ?? SUBAGENT_LIMITS.maxTokens;
  try {
    const deep = await runDeepModelAnalysis({
      ownerId,
      taskId: request.taskId,
      objective: request.objective,
      evidence: output.evidence,
      maxTokens: budget,
    });
    if (!deep.called) return output;
    return {
      ...output,
      summary: deep.text || output.summary,
      tokens: deep.inputTokens + deep.outputTokens,
      evidence: [
        ...output.evidence,
        {
          deepModel: true,
          provider: deep.provider,
          model: deep.model,
          costUsd: deep.costUsd,
          tokens: deep.inputTokens + deep.outputTokens,
        },
      ],
    };
  } catch (err) {
    const code = err instanceof Error && err.name === "BudgetExceededError" ? "budget_exceeded" : "deep_model_failed";
    return failed(skills, code, err instanceof Error ? err.message : String(err), output.evidence);
  }
}

export async function executeSpecialist(request: SubAgentRequest, skills: SkillUse[]): Promise<SubAgentOutput> {
  try {
    return await runBoundSpecialist(request, skills);
  } catch (err) {
    return failed(
      skills,
      `${request.role}_failed`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runBoundSpecialist(request: SubAgentRequest, skills: SkillUse[]): Promise<SubAgentOutput> {
  const candles = asCandles(request.context?.candles);
  const ownerId = ownerFrom(request);
  const ctx = silentContext(ownerId);

  if (request.role === "structure_analyst") {
    if (!candles) return failed(skills, "market_data_unavailable", "Structure specialist was not given candles.");
    const { runStructureAgent } = await import("@/lib/agent/agents/structureAgent");
    const market = await marketFromCandles(candles);
    const result = await runStructureAgent(ctx, market);
    return maybeDeepen(request, skills, {
      ...base(skills),
      status: "completed",
      summary: `Structure specialist trend=${result.trend}, swings=${result.swings.length}.`,
      evidence: [
        {
          specialist: "src/lib/agent/agents/structureAgent.ts",
          trend: result.trend,
          swings: result.swings.length,
          support: result.support.length,
          resistance: result.resistance.length,
          latestStructureEvent: result.latestStructureEvent?.type ?? null,
        },
      ],
      warnings: [],
      errors: [],
    });
  }

  if (request.role === "liquidity_analyst") {
    if (!candles) return failed(skills, "market_data_unavailable", "Liquidity specialist was not given candles.");
    const { runLiquidityAgent } = await import("@/lib/agent/agents/liquidityAgent");
    const market = await marketFromCandles(candles);
    const result = await runLiquidityAgent(ctx, market);
    return {
      ...base(skills),
      status: "completed",
      summary: `Liquidity specialist sweeps=${result.sweeps.length}, equalHighs=${result.equalHighs.length}, equalLows=${result.equalLows.length}.`,
      evidence: [
        {
          specialist: "src/lib/agent/agents/liquidityAgent.ts",
          sweeps: result.sweeps.length,
          equalHighs: result.equalHighs.length,
          equalLows: result.equalLows.length,
          latestSweep: result.latestSweep?.side ?? null,
        },
      ],
      warnings: [],
      errors: [],
    };
  }

  if (request.role === "macro_news_analyst") {
    const { newsProviderConfigured } = await import("@/lib/agent/news/newsProvider");
    if (!newsProviderConfigured()) {
      return failed(
        skills,
        "news_provider_unconfigured",
        "News specialist cannot confirm macro risk because no news provider is configured.",
        [{ specialist: "src/lib/agent/agents/newsMacroAgent.ts" }],
      );
    }
    const { runNewsMacroAgent } = await import("@/lib/agent/agents/newsMacroAgent");
    const result = await runNewsMacroAgent(ctx, { symbol: DATA_SYMBOL, message: request.objective });
    if (result.newsRisk === "unknown" && /not configured|unavailable/i.test(result.reason)) {
      return failed(skills, "news_provider_unconfigured", result.reason, [
        { specialist: "src/lib/agent/agents/newsMacroAgent.ts" },
      ]);
    }
    return {
      ...base(skills),
      status: "completed",
      summary: `News specialist risk=${result.newsRisk}, bias=${result.biasImpact}, events=${result.upcomingEvents.length}.`,
      evidence: [
        {
          specialist: "src/lib/agent/agents/newsMacroAgent.ts",
          newsRisk: result.newsRisk,
          biasImpact: result.biasImpact,
          events: result.upcomingEvents.length,
          reason: result.reason,
        },
      ],
      warnings: result.tradeAllowed ? [] : ["news_blocks_new_risk"],
      errors: [],
    };
  }

  if (request.role === "risk_reviewer") {
    if (!candles) return failed(skills, "market_data_unavailable", "Risk reviewer was not given candles.");
    const { runStructureAgent } = await import("@/lib/agent/agents/structureAgent");
    const { runLiquidityAgent } = await import("@/lib/agent/agents/liquidityAgent");
    const { runRiskAgent } = await import("@/lib/agent/agents/riskAgent");
    const market = await marketFromCandles(candles);
    const structure = await runStructureAgent(ctx, market);
    const liquidity = await runLiquidityAgent(ctx, market);
    const result = await runRiskAgent(ctx, {
      market,
      structure,
      supplyDemand: null,
      liquidity,
      mtf: null,
      news: null,
      educationalOnly: true,
    });
    return {
      ...base(skills),
      status: "completed",
      summary: `Risk reviewer action=${result.proposedTrade.action}, validation=${result.validation.accepted ? "ok" : "blocked"}.`,
      evidence: [
        {
          specialist: "src/lib/agent/agents/riskAgent.ts",
          action: result.proposedTrade.action,
          validationOk: result.validation.accepted,
          warnings: result.accountWarnings,
        },
      ],
      warnings: result.accountWarnings,
      errors: [],
    };
  }

  if (request.role === "research_agent") {
    if (ownerId == null) return failed(skills, "research_context_unavailable", "Research agent requires an owner id.");
    const { collectBoundedResearchEvidence } = await import("@/lib/agent/researchEvidence");
    const bundle = await collectBoundedResearchEvidence({
      userId: ownerId,
      symbol: DATA_SYMBOL,
      interval: "15m",
      actionableCandidate: false,
      userMessage: request.objective,
      latencyBudgetMs: 800,
    });
    return maybeDeepen(request, skills, {
      ...base(skills),
      status: "completed",
      summary: `Research agent used ${bundle.usedSystems.length} system(s) and skipped ${bundle.skippedSystems.length}.`,
      evidence: [
        {
          specialist: "src/lib/agent/researchEvidence.ts",
          used: bundle.usedSystems,
          skipped: bundle.skippedSystems.map((row) => row.reason),
        },
      ],
      warnings: [],
      errors: [],
    });
  }

  if (request.role === "memory_curator") {
    if (ownerId == null) return failed(skills, "memory_owner_missing", "Memory curator requires an owner id.");
    const { recallAgentMemoryForContext } = await import("@/lib/agent/agentMemory");
    const recall = await recallAgentMemoryForContext({
      userId: ownerId,
      query: request.objective,
      symbol: DATA_SYMBOL,
      timeframe: "15m",
      locale: "en",
    });
    const memoryCount = recall.memories?.length ?? 0;
    const lessonCount = recall.tradeLessons?.length ?? 0;
    return {
      ...base(skills),
      status: "completed",
      summary: `Memory curator recalled ${memoryCount} memories and ${lessonCount} lessons.`,
      evidence: [
        {
          specialist: "src/lib/agent/agentMemory.ts",
          memories: memoryCount,
          lessons: lessonCount,
          warnings: recall.warnings ?? [],
        },
      ],
      warnings: recall.warnings ?? [],
      errors: [],
    };
  }

  if (request.role === "market_watcher") {
    const { getSessionStatus } = await import("@/lib/markets/tradingCalendar");
    const { getTradingSessionInfo } = await import("@/lib/agent/core/tradingSessions");
    const calendar = getSessionStatus(DATA_SYMBOL);
    const session = getTradingSessionInfo();
    let recommendations = 0;
    if (ownerId != null) {
      const { listActiveTrackedRecommendations } = await import("@/lib/recommendations/recommendationStore");
      const open = await listActiveTrackedRecommendations({ userId: ownerId }).catch(() => []);
      recommendations = open.length;
    }
    return {
      ...base(skills),
      status: "completed",
      summary: `Market watcher session=${session.primary ?? "none"} open=${calendar.isOpen} recommendations=${recommendations}.`,
      evidence: [
        {
          specialist: "src/lib/recommendations/recommendationTracker.ts",
          session: session.primary ?? null,
          marketOpen: calendar.isOpen,
          recommendations,
        },
      ],
      warnings: calendar.isOpen ? [] : ["market_closed"],
      errors: [],
    };
  }

  if (request.role === "system_guardian") {
    const { countTasksByStatus } = await import("./tasks");
    const counts = await countTasksByStatus();
    const failedTasks = counts.failed ?? 0;
    return {
      ...base(skills),
      status: "completed",
      summary: failedTasks > 0 ? `Gateway has ${failedTasks} failed task(s).` : "Gateway task ledger is clear.",
      evidence: [{ specialist: "src/lib/gateway/status.ts", failed: failedTasks, counts }],
      warnings: failedTasks > 0 ? ["failed_tasks"] : [],
      errors: [],
      followUpSuggested: failedTasks > 0,
    };
  }

  if (request.role === "supervisor") {
    const memory = request.context?.goalMemory;
    if (!candles && (memory == null || typeof memory !== "object")) {
      return failed(skills, "supervisor_context_unavailable", "Supervisor had neither candles nor goal memory.");
    }
    if (!candles) {
      const snapshot = memory as Record<string, unknown>;
      const summary = typeof snapshot.summary === "string" ? snapshot.summary : request.objective;
      return {
        ...base(skills),
        status: "completed",
        summary: `Supervisor continued from goal memory: ${summary.slice(0, 400)}`,
        evidence: [{ specialist: "src/lib/agent/orchestrator.ts", goalMemory: snapshot }],
        warnings: [],
        errors: [],
      };
    }
    const { runStructureAgent } = await import("@/lib/agent/agents/structureAgent");
    const market = await marketFromCandles(candles);
    const structure = await runStructureAgent(ctx, market);
    return maybeDeepen(request, skills, {
      ...base(skills),
      status: "completed",
      summary: `Supervisor delegated to the structure specialist: trend=${structure.trend}, swings=${structure.swings.length}.`,
      evidence: [
        {
          specialist: "src/lib/agent/orchestrator.ts",
          delegated: "src/lib/agent/agents/structureAgent.ts",
          trend: structure.trend,
          swings: structure.swings.length,
          goalMemory: request.context?.goalMemory ?? null,
        },
      ],
      warnings: [],
      errors: [],
    });
  }

  return failed(skills, "unknown_role", `No specialist executor is bound for ${request.role}.`);
}
