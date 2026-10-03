/**
 * Lonora Agent Gateway process (pm2 app `aichart-worker` / `npm run worker`).
 *
 * No longer a cron executor: one long-lived host boots, loads warm state
 * once, and then wakes on events from the unified queue — user messages,
 * scheduled ticks, market events. The legacy BullMQ job worker (embeddings,
 * post-mortems) runs inside the same process so the system stays ONE
 * resident process.
 *
 * Requires REDIS_URL for the durable stream; without it the bus runs
 * in-memory (dev only — events do not survive a restart).
 */
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { registerAllChannelSenders } from "./lib/channels/registry";
import { initDb } from "./lib/db";
import { createLogger } from "./lib/logger";
import { shutdownQueue, startWorker } from "./lib/queue";
import { createEventBus } from "./lib/resident/bus";
import { ResidentHost } from "./lib/resident/host";
import { ResidentAgentRunner } from "./lib/resident/residentAgentRunner";

const log = createLogger("worker");

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL?.trim()) {
    log.error("REDIS_URL is required for the gateway in production");
    process.exit(1);
  }
  await initDb();
  const { ensureOwner } = await import("./lib/ownerIdentity");
  await ensureOwner();

  const host = new ResidentHost({
    bus: createEventBus(),
    runner: new ResidentAgentRunner(),
    concurrency: Number(process.env.RESIDENT_CONCURRENCY || 8),
    healthPort: Number(process.env.RESIDENT_HEALTH_PORT || 8791),
    maxUptimeMs: Number(process.env.RESIDENT_MAX_UPTIME_MS || 24 * 60 * 60 * 1000),
    marketWatchEveryMs: Number(process.env.GATEWAY_MARKET_WATCH_MS || 60_000),
    goalDispatchEveryMs: Number(process.env.GATEWAY_GOAL_DISPATCH_MS || 30_000),
    taskReclaimEveryMs: Number(process.env.GATEWAY_TASK_RECLAIM_MS || 45_000),
    guardianEveryMs: Number(process.env.GATEWAY_GUARDIAN_MS || 120_000),
    notifyEveryMs: Number(process.env.GATEWAY_NOTIFY_DELIVERY_MS || 15_000),
    heartbeatEveryMs: Number(process.env.GATEWAY_HEARTBEAT_MS || 30_000),
  });
  // Outbound channels (Telegram today): how user_message events queued by
  // the web process get their replies delivered from this process.
  registerAllChannelSenders(host);
  await host.start();

  // Legacy job tier (embeddings, post-mortems) — same process, same lifetime.
  await startWorker();

  log.info("resident agent process ready");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    try {
      await host.shutdown(signal);
      await shutdownQueue();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("resident bootstrap failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
