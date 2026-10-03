/**
 * Layered XAUUSD monitor.
 *
 * Layer 1 is a deterministic fingerprint (candle, session, price bucket,
 * open recommendations). Layer 2 queues a specialist task only when that
 * fingerprint changes in a material way. Layer 3 notifies only through the
 * deduped notification ledger. Closed markets do not invent live movement.
 */
import { createHash } from "node:crypto";
import { getTradingSessionInfo } from "@/lib/agent/core/tradingSessions";
import { getSessionStatus } from "@/lib/markets/tradingCalendar";
import { DATA_SYMBOL } from "@/lib/gold";
import { readGoldCandles } from "@/lib/gold/candleStore";
import { createLogger } from "@/lib/logger";
import { listActiveTrackedRecommendations } from "@/lib/recommendations/recommendationStore";
import { getFlag, setFlag } from "@/lib/store";
import { createTask } from "./tasks";
import { claimNotification } from "./notify";

const log = createLogger("gateway.market");

const FINGERPRINT_FLAG = "gateway_market_fingerprint";
const LAST_EVENT_FLAG = "gateway_market_last_event";

export interface MarketSnapshot {
  symbol: string;
  candleTime: number | null;
  close: number | null;
  session: string;
  marketOpen: boolean;
  openRecommendationIds: string[];
}

export interface MarketAssessment {
  material: boolean;
  deep: boolean;
  reasons: string[];
  fingerprint: string;
}

export function marketFingerprint(snapshot: MarketSnapshot): string {
  const ids = [...snapshot.openRecommendationIds].sort().join(",");
  const price =
    snapshot.close == null ? "" : (Math.round(snapshot.close * 10) / 10).toFixed(1);
  const raw = [
    snapshot.symbol,
    snapshot.marketOpen ? "open" : "closed",
    snapshot.session,
    snapshot.candleTime ?? "",
    price,
    ids,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function assessMarketChange(
  previous: MarketSnapshot | null,
  next: MarketSnapshot,
  thresholdPct = 0.15,
): MarketAssessment {
  const fingerprint = marketFingerprint(next);
  if (!previous) {
    return {
      material: true,
      deep: next.marketOpen,
      reasons: ["baseline"],
      fingerprint,
    };
  }
  const reasons: string[] = [];
  if (previous.session !== next.session) reasons.push("session_transition");
  if (previous.candleTime !== next.candleTime && next.candleTime != null) reasons.push("fresh_candle");
  const prevIds = [...previous.openRecommendationIds].sort().join(",");
  const nextIds = [...next.openRecommendationIds].sort().join(",");
  if (prevIds !== nextIds) reasons.push("recommendation_change");
  if (
    next.marketOpen &&
    previous.close != null &&
    next.close != null &&
    previous.close > 0
  ) {
    const pct = (Math.abs(next.close - previous.close) / previous.close) * 100;
    if (pct >= thresholdPct) reasons.push("price_move");
  }
  const material = reasons.length > 0;
  const deep =
    material &&
    next.marketOpen &&
    reasons.some((reason) =>
      ["fresh_candle", "price_move", "recommendation_change", "session_transition"].includes(reason),
    );
  return { material, deep, reasons, fingerprint };
}

export async function readMarketSnapshot(ownerId: number): Promise<MarketSnapshot> {
  const calendar = getSessionStatus(DATA_SYMBOL);
  const sessionInfo = getTradingSessionInfo();
  let candleTime: number | null = null;
  let close: number | null = null;
  try {
    const candles = await readGoldCandles({ timeframe: "15m", limit: 1 });
    const last = candles[candles.length - 1];
    if (last) {
      candleTime = Number(last.time);
      close = Number(last.close);
    }
  } catch (err) {
    log.warn("market.candles_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const open = await listActiveTrackedRecommendations({ userId: ownerId }).catch(() => []);
  return {
    symbol: DATA_SYMBOL,
    candleTime: Number.isFinite(candleTime) ? candleTime : null,
    close: Number.isFinite(close) ? close : null,
    session: sessionInfo.primary ?? (calendar.isOpen ? "open" : "closed"),
    marketOpen: calendar.isOpen,
    openRecommendationIds: open.map((row) => String(row.id)),
  };
}

function parseSnapshot(raw: string | null): MarketSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as MarketSnapshot;
    if (!value || typeof value !== "object" || !value.symbol) return null;
    return value;
  } catch {
    return null;
  }
}

export interface MarketWatchResult {
  material: boolean;
  deep: boolean;
  reasons: string[];
  fingerprint: string;
  taskId: string | null;
  notified: boolean;
  notificationReason: string;
  marketOpen: boolean;
  error: string | null;
}

export async function runMarketWatch(opts: {
  ownerId: number;
  previous?: MarketSnapshot | null;
  snapshot?: MarketSnapshot;
  notify?: boolean;
} ): Promise<MarketWatchResult> {
  let snapshot: MarketSnapshot;
  let error: string | null = null;
  try {
    snapshot = opts.snapshot ?? (await readMarketSnapshot(opts.ownerId));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    snapshot = {
      symbol: DATA_SYMBOL,
      candleTime: null,
      close: null,
      session: "unknown",
      marketOpen: false,
      openRecommendationIds: [],
    };
  }
  if (snapshot.close == null && snapshot.candleTime == null) {
    error = error ?? "market_data_unavailable";
  }
  const previous = opts.previous === undefined
    ? parseSnapshot(await getFlag(FINGERPRINT_FLAG))
    : opts.previous;
  const assessment = assessMarketChange(previous, snapshot);
  await setFlag(FINGERPRINT_FLAG, JSON.stringify(snapshot));
  let taskId: string | null = null;
  let notified = false;
  let notificationReason = "not_material";
  if (assessment.material && assessment.deep && !error) {
    let candles: unknown[] | undefined;
    if (!opts.snapshot) {
      candles = await readGoldCandles({ timeframe: "15m", limit: 40 }).catch(() => []);
    }
    const task = await createTask({
      ownerId: opts.ownerId,
      role: "structure_analyst",
      objective: `Material XAUUSD change: ${assessment.reasons.join(", ")}`,
      idempotencyKey: `market:${assessment.fingerprint}`,
      input: {
        reasons: assessment.reasons,
        fingerprint: assessment.fingerprint,
        candles,
        model: process.env.GATEWAY_DEEP_MODEL === "1" ? "allowed" : "deterministic_only",
      },
    });
    taskId = task.id;
  }
  if (assessment.material && opts.notify !== false && !error) {
    const claim = await claimNotification({
      ownerId: opts.ownerId,
      dedupeKey: `market:${assessment.fingerprint}`,
      channel: "telegram",
      reason: assessment.reasons.join(","),
      body: `XAUUSD: ${assessment.reasons.join(", ")}`,
      taskId,
    });
    notified = claim.deliver;
    notificationReason = claim.reason;
  } else if (!assessment.material) {
    notificationReason = "unchanged";
  } else if (error) {
    notificationReason = error;
  }
  const last = {
    at: new Date().toISOString(),
    fingerprint: assessment.fingerprint,
    reasons: assessment.reasons,
    material: assessment.material,
    deep: assessment.deep,
    marketOpen: snapshot.marketOpen,
    error,
    taskId,
  };
  await setFlag(LAST_EVENT_FLAG, JSON.stringify(last));
  log.info("market.watch", last);
  return {
    ...assessment,
    taskId,
    notified,
    notificationReason,
    marketOpen: snapshot.marketOpen,
    error,
  };
}

export async function lastMarketEvent(): Promise<Record<string, unknown> | null> {
  const raw = await getFlag(LAST_EVENT_FLAG);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
