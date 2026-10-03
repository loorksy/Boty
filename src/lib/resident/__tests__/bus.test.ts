import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBus, RedisStreamBus } from "@/lib/resident/bus";
import type { ResidentEvent } from "@/lib/resident/events";

function tick(): ResidentEvent {
  return { kind: "scheduled_tick", tick: "recommendation_sweep", enqueuedAt: Date.now() };
}

test("memory bus delivers with bounded concurrency", async () => {
  const bus = new MemoryBus();
  let active = 0;
  let peak = 0;
  let handled = 0;
  await bus.start(
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      handled += 1;
    },
    { concurrency: 2 },
  );
  for (let i = 0; i < 6; i++) await bus.publish(tick());
  await bus.idle();
  assert.equal(handled, 6);
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded 2`);
  assert.ok(peak >= 2, "events did not actually overlap");
  await bus.stop();
});

test("memory bus retries a failed event exactly once", async () => {
  const bus = new MemoryBus();
  let attempts = 0;
  await bus.start(
    async () => {
      attempts += 1;
      throw new Error("boom");
    },
    { concurrency: 1 },
  );
  await bus.publish(tick());
  await bus.idle();
  assert.equal(attempts, 2);
});

test("memory bus collapses a repeated idempotency key", async () => {
  const bus = new MemoryBus();
  let handled = 0;
  await bus.start(
    async () => {
      handled += 1;
    },
    { concurrency: 1 },
  );
  const event: ResidentEvent = {
    kind: "market_event",
    event: "fresh_candle",
    symbol: "XAUUSD",
    idempotencyKey: "market-fingerprint-01",
    enqueuedAt: Date.now(),
  };
  const first = await bus.publish(event);
  const second = await bus.publish(event);
  await bus.idle();
  assert.equal(first, second);
  assert.equal(handled, 1);
  await bus.stop();
});

test("memory bus validates events at publish", async () => {
  const bus = new MemoryBus();
  await assert.rejects(
    () => bus.publish({ kind: "nope" } as unknown as ResidentEvent),
    (err: Error) => err.name === "InvalidResidentEventError",
  );
});

async function requireRedis(): Promise<string> {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const { default: IORedis } = await import("ioredis");
  const probe = new IORedis(url, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 1_000 });
  try {
    await probe.connect();
    await probe.ping();
    return url;
  } finally {
    probe.disconnect();
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for redis bus");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("redis streams: group, dedupe, restart, reclaim, and dead-letter", async () => {
  const url = await requireRedis();
  const { default: IORedis } = await import("ioredis");
  const admin = new IORedis(url, { maxRetriesPerRequest: 1 });
  const previousMax = process.env.GATEWAY_EVENT_MAX_ATTEMPTS;
  try {
    const stream = `lonora:test:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const group = "lonora-host";
    process.env.GATEWAY_EVENT_MAX_ATTEMPTS = "5";

    const parked = new RedisStreamBus({ url, stream, group, consumer: "down" });
    const event: ResidentEvent = {
      kind: "scheduled_tick",
      tick: "market_watch",
      enqueuedAt: Date.now(),
      idempotencyKey: "market-watch-restart-01",
    };
    await parked.publish(event);
    await parked.publish(event);
    await parked.stop();

    const got: string[] = [];
    const live = new RedisStreamBus({ url, stream, group, consumer: "restarted" });
    await live.start(
      async ({ event: delivered }) => {
        got.push(delivered.idempotencyKey ?? delivered.kind);
      },
      { concurrency: 1 },
    );
    await waitFor(() => got.length >= 1);
    assert.equal(got.length, 1, "a duplicate idempotency key must not run twice");
    const groups = (await admin.xinfo("GROUPS", stream)) as unknown[];
    assert.ok(groups.length >= 1, "consumer group exists");
    await live.stop();

    const reclaimStream = `${stream}:reclaim`;
    let firstAttempts = 0;
    const holder = new RedisStreamBus({
      url,
      stream: reclaimStream,
      group,
      consumer: "holder",
      reclaimMinIdleMs: 40,
    });
    await holder.start(
      async () => {
        firstAttempts += 1;
        throw new Error("worker stopped mid-task");
      },
      { concurrency: 1 },
    );
    await holder.publish({ kind: "scheduled_tick", tick: "goal_dispatch", enqueuedAt: Date.now() });
    await waitFor(() => firstAttempts >= 1);
    await holder.stop();
    await new Promise((r) => setTimeout(r, 80));

    const reclaimed: number[] = [];
    const heir = new RedisStreamBus({
      url,
      stream: reclaimStream,
      group,
      consumer: "heir",
      reclaimMinIdleMs: 40,
    });
    await heir.start(
      async ({ attempt }) => {
        reclaimed.push(attempt);
      },
      { concurrency: 1 },
    );
    await waitFor(() => reclaimed.length >= 1);
    assert.ok(reclaimed[0]! >= 2, "XAUTOCLAIM delivers the pending entry to the new consumer");
    await heir.stop();

    process.env.GATEWAY_EVENT_MAX_ATTEMPTS = "1";
    const deadStream = `${stream}:dead`;
    const poison = new RedisStreamBus({ url, stream: deadStream, group, consumer: "poison" });
    await poison.start(
      async () => {
        throw new Error("poison task");
      },
      { concurrency: 1 },
    );
    await poison.publish({ kind: "scheduled_tick", tick: "guardian", enqueuedAt: Date.now() });
    await waitFor(async () => {
      const len = await admin.xlen(`${deadStream}:dead`);
      return Number(len) >= 1;
    });
    const dead = await admin.xlen(`${deadStream}:dead`);
    assert.ok(Number(dead) >= 1, "poison events move to the dead-letter stream");
    await poison.stop();
  } finally {
    if (previousMax === undefined) delete process.env.GATEWAY_EVENT_MAX_ATTEMPTS;
    else process.env.GATEWAY_EVENT_MAX_ATTEMPTS = previousMax;
    admin.disconnect();
  }
});
