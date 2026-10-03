"use client";

import { useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import type { GatewayStatus } from "@/lib/gateway/status";

export function ControlCenter({ initial }: { initial: GatewayStatus }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<GatewayStatus>(initial);
  const [error, setError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/gateway/status", { cache: "no-store" });
    const body = (await res.json()) as GatewayStatus & { error?: string };
    if (!res.ok) {
      setError(body.error ?? "status_unavailable");
      return;
    }
    setError(null);
    setStatus(body);
  }

  async function post(url: string, payload: unknown) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "request_failed");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const paused = status?.paused === true || status?.status === "paused";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("control.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("control.private")}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded-full border px-3 py-1 text-sm" onClick={() => void load()}>
            {t("control.refresh")}
          </button>
          <button
            type="button"
            className="rounded-full border px-3 py-1 text-sm"
            disabled={busy}
            onClick={() => void post("/api/gateway/control", { paused: !paused })}
          >
            {paused ? t("control.resume") : t("control.pause")}
          </button>
        </div>
      </header>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label={t("control.gateway")} value={status?.status ?? "…"} />
        <Card label={t("control.queue")} value={status?.queue?.backend ?? "…"} />
        <Card label={t("control.uptime")} value={formatUptime(status?.uptimeMs)} />
        <Card
          label={t("control.provider")}
          value={`openai ${status?.providers?.openai ? "yes" : "no"} · anthropic ${status?.providers?.anthropic ? "yes" : "no"}`}
        />
      </section>

      <section className="rounded-xl border p-4">
        <h2 className="font-medium">{t("control.goals")}</h2>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const text = objective.trim();
            if (text.length < 8) return;
            void post("/api/gateway/goals", { objective: text }).then(() => setObjective(""));
          }}
        >
          <input
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm"
            placeholder="Monitor gold and tell me when structure changes"
          />
          <button type="submit" className="rounded-full border px-4 py-2 text-sm" disabled={busy}>
            {t("control.goals")}
          </button>
        </form>
        <p className="mt-2 text-sm text-muted-foreground">
          active {status?.goals?.active ?? 0} · paused {status?.goals?.paused ?? 0} · failed{" "}
          {status?.goals?.failed ?? 0}
        </p>
      </section>

      <section className="rounded-xl border p-4">
        <h2 className="font-medium">{t("control.tasks")}</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {(status?.recentTasks ?? []).length === 0 ? <li>{t("control.empty")}</li> : null}
          {(status?.recentTasks ?? []).map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-2">
              <span>
                {task.status} · {task.role}
                {task.error ? ` · ${task.error}` : ""}
              </span>
              {task.status !== "completed" && task.status !== "cancelled" && task.status !== "failed" ? (
                <button
                  type="button"
                  className="rounded-full border px-2 py-0.5 text-xs"
                  onClick={() => void post("/api/gateway/tasks", { action: "cancel", id: task.id })}
                >
                  {t("control.cancel")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border p-4">
          <h2 className="font-medium">{t("control.subagents")}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {(status?.subagents ?? []).length === 0 ? <li>{t("control.empty")}</li> : null}
            {(status?.subagents ?? []).map((agent) => (
              <li key={agent.id}>
                {agent.status} · {agent.role}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border p-4">
          <h2 className="font-medium">{t("control.market")}</h2>
          <p className="mt-2 text-sm">
            {t("control.open_recs")}: {status?.openRecommendations ?? "—"}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("control.last_market")}: {String(status?.market?.at ?? t("control.empty"))}
          </p>
          <p className="mt-3 text-sm">
            {t("control.costs")}: {t("control.today")} ${Number(status?.costs?.todayUsd ?? 0).toFixed(4)} ·{" "}
            {t("control.month")} ${Number(status?.costs?.monthUsd ?? 0).toFixed(4)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("control.failures")}: {(status?.failures ?? []).join(", ") || t("control.empty")}
          </p>
        </div>
      </section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-medium">{value}</div>
    </div>
  );
}

function formatUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
