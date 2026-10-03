/**
 * Owner operating cost. This is provider spend, not a customer balance.
 */
import { query } from "@/lib/db";
import { getOwnerId } from "@/lib/ownerIdentity";

export interface CostBucket {
  provider: string;
  model: string;
  kind: string;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
}

export interface OwnerCostSummary {
  todayUsd: number;
  monthUsd: number;
  byModel: CostBucket[];
  todayByKind: Array<{ kind: string; providerCostUsd: number }>;
}

function startOfUtcDay(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export async function ownerCostSummary(now = Date.now()): Promise<OwnerCostSummary> {
  const ownerId = await getOwnerId();
  if (ownerId == null) {
    return { todayUsd: 0, monthUsd: 0, byModel: [], todayByKind: [] };
  }
  const day = startOfUtcDay(now);
  const month = startOfUtcMonth(now);
  const rows = await query<{
    provider: string;
    model: string;
    kind: string;
    input_tokens: number;
    output_tokens: number;
    provider_cost_usd: number | null;
  }>(
    `SELECT provider, model, kind,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(COALESCE(provider_cost_usd, 0)) AS provider_cost_usd
     FROM usage_events
     WHERE user_id = ? AND ts >= ?
     GROUP BY provider, model, kind`,
    [ownerId, month],
  );
  const byModel: CostBucket[] = rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    kind: row.kind,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    providerCostUsd: Number(row.provider_cost_usd ?? 0),
  }));
  const todayRows = await query<{ kind: string; provider_cost_usd: number | null }>(
    `SELECT kind, SUM(COALESCE(provider_cost_usd, 0)) AS provider_cost_usd
     FROM usage_events
     WHERE user_id = ? AND ts >= ?
     GROUP BY kind`,
    [ownerId, day],
  );
  const todayUsd = todayRows.reduce((sum, row) => sum + Number(row.provider_cost_usd ?? 0), 0);
  const monthUsd = byModel.reduce((sum, row) => sum + row.providerCostUsd, 0);
  return {
    todayUsd,
    monthUsd,
    byModel,
    todayByKind: todayRows.map((row) => ({
      kind: row.kind,
      providerCostUsd: Number(row.provider_cost_usd ?? 0),
    })),
  };
}
