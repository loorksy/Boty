# Lonora Agent Gateway

Lonora is one private gold-market operator. Web, Telegram, and MCP are doors
into the same owner, the same memory, and the same Gateway.

## 1. Owner identity

`src/lib/ownerIdentity.ts` resolves exactly one owner:

1. `AICHART_AGENT_USER_ID` when that user exists. A pin that does not match is an error, not a fallback.
2. `LONORA_OWNER_EMAIL` when it matches one account.
3. `ADMIN_EMAIL` when it matches one account.
4. The only user, when the database contains exactly one account and nothing is pinned.

Several accounts and no matching pin is `OwnerAmbiguousError`. The gateway
does not promote the earliest admin or the earliest user. Run
`npm run migrate:single-owner` (dry-run first). `--apply` refuses before any
write when a unique key would collide, and owner promotion, row remaps, and
optional suspension commit in one transaction.

`getOwnerId()` does not create accounts. `ensureOwner()` promotes the resolved
row to an active admin. `requireOwner()` rejects every other session.
`assertOwnerUserId()` is the check used by Google, Telegram login, and the bot.

Public registration is closed. `isRegistrationOpen()` stays false. The register
route returns `403 REGISTRATION_CLOSED`. Unknown Telegram chats are not turned
into users. A link code binds a chat only when it belongs to the owner.

`user_id` columns remain the owner's foreign key. No request can select another
user.

## 2. Gateway architecture

The resident process is the Gateway. `src/worker.ts` boots `ResidentHost` and
refuses to start in production without `REDIS_URL`. There is no second gateway
process.

The host consumes `lonora:events` (`src/lib/resident/bus.ts`) and runs the
existing specialist loop for conversations. Gateway ticks are additional
scheduled events on that same bus:

- `market_watch`
- `goal_dispatch`
- `task_reclaim`
- `guardian`
- `notify_delivery`

The host writes `gateway_heartbeat` on its own timer (`GATEWAY_HEARTBEAT_MS`,
default 30s). `/healthz` and `/api/gateway/status` read that flag. They do
not refresh it. A beat older than `GATEWAY_HEARTBEAT_STALE_MS` (default 180s)
lets the external cron watchdog run. The guardian reuses one
`system_guardian` row and updates it only when the failure signature changes.

## 3. Event flow

Producers (web queue, Telegram adapter, schedules, market watch) publish a
validated event. Redis Streams keep it until the handler ACKs. A duplicate
`idempotencyKey` is not enqueued again. A failed delivery stays pending for
`XAUTOCLAIM`. After `GATEWAY_EVENT_MAX_ATTEMPTS` (default 5) it is copied to
`lonora:events:dead` and ACKed so it cannot poison the group. The in-memory
bus is for development and tests; it retries once, matching the existing bus
test, and is not production persistence.

## 4. Persistent goals and tasks

Tables (created for SQLite and Postgres in `src/lib/gateway/schema.ts`):

- `agent_goals` — active, paused, completed, failed, cancelled
- `agent_tasks` — queued, claimed, running, waiting, waiting_for_approval, completed, failed, cancelled
- `agent_task_runs` — one row per attempt. A retry inserts another row.
- `agent_schedules` — cadence
- `agent_approvals` — external-write holds
- `agent_subagents` — one row per delegation
- `gateway_notifications` — durable delivery intent, unique `dedupe_key`
- `gateway_event_dedupe`

A task lease expires. `reclaimStaleTasks()` queues it again, or fails it at
`max_attempts`. Cancelling a goal cancels its open task. A paused or cancelled
goal is not scheduled.

Natural language on Telegram or the web (`src/lib/gateway/responsibility.ts`)
creates a goal when the utterance is a responsibility. Slash commands are
controls, not goals. The control center can also create one explicitly.

## 5. Sub-agent model

The owner talks to one supervisor. `delegateSubAgent()` may call a named role.
Depth `1` and above is rejected (`maxDepth` is 1), so a child cannot create
another child. A parent run allows 4 children. Six concurrent sub-agents is
the cap. Each run has a timeout and a token budget.

Roles reuse existing modules (`src/lib/gateway/roles.ts`): structure,
liquidity, macro/news, risk, research evidence, memory, the recommendation
tracker, and the orchestrator. They are not reimplemented.

## 6. Skills

`selectSkillsForRole()` loads only the skill names that role declares, from
the existing workspace skill registry. A missing required skill fails the
delegation. Skill text is not dumped into every prompt, and a skill cannot
widen the tool allowlist.

## 7. Permissions

`src/lib/gateway/permissions.ts` classes tools as READ, INTERNAL_WRITE,
NOTIFY, EXTERNAL_WRITE, or TRADE_EXECUTION. Trade tools throw
`TradeBoundaryError` even if a caller adds them to an allowlist.
EXTERNAL_WRITE is not granted to sub-agents. A task that needs one enters
`waiting_for_approval` with an `agent_approvals` row. The owner approves or
rejects it from the control center. Approval does not run an external adapter
and cannot authorize a trade tool. NOTIFY requires `allowNotify`. External content is wrapped as
`<untrusted_data>` and cannot replace the policy object.

## 8. Memory

Conversation memory stays in the resident session, chat history, semantic
memory, and lessons, all keyed by the owner. Channel ids still separate
transport threads. Goal memory (`summary`, `latest_findings`, `last_action`,
`next_check_at`) is separate so a long responsibility does not replay the
transcript. `updateGoalMemory()` writes the summary, latest findings, last
action, fingerprint, and next check after a goal task finishes. The next
dispatch puts that snapshot on the new task.

## 9. Market monitor

`runMarketWatch()` fingerprints the latest XAUUSD candle, session, and open
recommendations. An unchanged fingerprint does not enqueue analysis or a
notification. A closed market never counts as a live price move and does not
start a deep task. A material open-market change enqueues one
`structure_analyst` task keyed by the fingerprint. `GATEWAY_DEEP_MODEL=1`
is the only switch that lets that task call the deep model through `callLLM`.
The call is metered on `usage_events` and stopped when it exceeds the task
token budget. Unset or `0` keeps the deterministic specialist and does not
call a model. Claimed delivery is an intent (`pending`), not a sent message.

## 10. Telegram

Free text still reaches Lonora. `/status`, `/tasks`, `/goals`, `/agents`,
`/pause`, and `/resume` are mechanical. Proactive notices go through
`claimNotification()` stores one pending row per dedupe key. A delivery tick
sends it through Telegram, then `markNotificationSent`. A transport failure
becomes `retry` and later `failed` at `GATEWAY_NOTIFY_MAX_ATTEMPTS`. The
hourly cap is `GATEWAY_NOTIFY_MAX_PER_HOUR` (default 6). Command text uses
the owner's account language.

## 11. Recovery

Tasks and goals are database rows. A process restart reclaims expired leases.
Redis redelivers unacked events. pm2 `autorestart` restarts the worker.
A missing Redis in production aborts startup instead of silently falling
back to memory. A provider or market-data failure is stored as an error
string, not as a successful result.

## 12. Deployment

pm2 runs `aichart-web`, `aichart-mcp`, and `aichart-worker`. The chart host
stays in Docker. Redis is required. See `infra/pm2.ecosystem.config.cjs` and
`docs/vps-install.md`.

`infra/aichart.cron` remains installed. Sweep, candle sync, and event-monitor
are watchdogs: a fresh gateway heartbeat makes those routes return
`skipped: gateway_authoritative`. Case-memory and tradability calibration are
still cron-owned because the gateway does not duplicate them.

## 13. Health

`GET /api/gateway/status` (owner session) returns status, uptime, version,
commit, queue backend, heartbeat, Redis configuration, task and goal counts,
sub-agents, the last market event, open recommendations, provider
availability, and operator cost. It does not return secrets. The worker also
exposes the existing health port (`RESIDENT_HEALTH_PORT`, default 8791).

## 14. Cost controls

Layer 1 is deterministic. Layer 2 enqueues specialist work only on a new
fingerprint. Layer 3 notifies only when the dedupe and rate checks pass.
`usage_events` still records provider cost. `/console/billing` and
`/api/gateway/costs` show that spend to the owner. Customer balances,
checkout, and subscription grants are retired (`410`).

## 15. Manual trading boundary

`src/lib/__tests__/manualExecutionGuard.test.ts` walks imports. The gateway,
resident host, orchestrator, sweep, and market monitor cannot reach
`orders.ts`, `metaapiTrade.ts`, or the Telegram execution flow. Sub-agent
allowlists contain no order tools, and `assertToolPermitted` rejects them
unconditionally. Only the existing human confirmation routes can import the
execution layer.
