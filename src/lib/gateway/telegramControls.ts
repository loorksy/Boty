/**
 * Mechanical Telegram controls. Free text is not parsed here; responsibility
 * language is absorbed separately and still reaches Lonora.
 * Copy comes from the owner's account language, the same map as the rest of Lonora.
 */
import { t, type AppLocale } from "@/lib/i18n";
import { resolveUserLocale } from "@/lib/i18n/userLocale";
import { getOwnerId } from "@/lib/ownerIdentity";
import { listGoals, pauseGoal, resumeGoal } from "./goals";
import { listSubAgents } from "./subagents";
import { listTasks } from "./tasks";
import { isGatewayPaused, setGatewayPaused } from "./runtime";
import { buildGatewayStatus } from "./status";

export interface GatewayCommandResult {
  text: string;
}

function argOf(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  return parts[1] ?? null;
}

function statusLabel(locale: AppLocale, status: string): string {
  const key = `tg.gw.st.${status}`;
  const translated = t(locale, key);
  return translated === key ? status : translated;
}

export async function handleGatewayTelegramCommand(
  text: string,
  locale?: AppLocale,
): Promise<GatewayCommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const command = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  const known = new Set(["/status", "/tasks", "/goals", "/agents", "/pause", "/resume", "/paused"]);
  if (!known.has(command)) return null;
  const ownerId = await getOwnerId();
  const lang = locale ?? (await resolveUserLocale(ownerId));

  if (command === "/status") {
    const status = await buildGatewayStatus();
    const failures = status.failures.length
      ? t(lang, "tg.gw.failures", { list: status.failures.join(", ") })
      : t(lang, "tg.gw.failures_none");
    return {
      text: t(lang, "tg.gw.status", {
        status: statusLabel(lang, status.status),
        backend: status.queue.backend,
        redis: status.redis.configured ? t(lang, "tg.gw.redis_up") : t(lang, "tg.gw.redis_down"),
        goals: String(status.goals.active),
        failed: String(status.tasks.failed ?? 0),
        failures,
      }),
    };
  }
  if (command === "/tasks") {
    const tasks = await listTasks({ limit: 8 });
    if (!tasks.length) return { text: t(lang, "tg.gw.tasks_empty") };
    return {
      text: tasks
        .map((task) =>
          t(lang, "tg.gw.task_line", {
            status: statusLabel(lang, task.status),
            role: task.role,
            id: task.id.slice(0, 8),
          }),
        )
        .join("\n"),
    };
  }
  if (command === "/goals") {
    const goals = await listGoals();
    if (!goals.length) return { text: t(lang, "tg.gw.goals_empty") };
    return {
      text: goals
        .slice(0, 8)
        .map((goal) =>
          t(lang, "tg.gw.goal_line", {
            status: statusLabel(lang, goal.status),
            kind: goal.kind,
            title: goal.title,
          }),
        )
        .join("\n"),
    };
  }
  if (command === "/agents") {
    const agents = await listSubAgents(8);
    if (!agents.length) return { text: t(lang, "tg.gw.agents_empty") };
    return {
      text: agents
        .map((agent) =>
          t(lang, "tg.gw.agent_line", {
            status: statusLabel(lang, agent.status),
            role: agent.role,
          }),
        )
        .join("\n"),
    };
  }
  if (command === "/pause") {
    const id = argOf(trimmed);
    if (id) {
      const goal = await pauseGoal(id);
      return { text: goal ? t(lang, "tg.gw.paused_goal", { title: goal.title }) : t(lang, "tg.gw.goal_missing") };
    }
    await setGatewayPaused(true);
    return { text: t(lang, "tg.gw.gateway_paused") };
  }
  if (command === "/resume") {
    const id = argOf(trimmed);
    if (id) {
      const goal = await resumeGoal(id);
      return { text: goal ? t(lang, "tg.gw.resumed_goal", { title: goal.title }) : t(lang, "tg.gw.goal_missing") };
    }
    await setGatewayPaused(false);
    return { text: t(lang, "tg.gw.gateway_resumed") };
  }
  return { text: (await isGatewayPaused()) ? t(lang, "tg.gw.paused") : t(lang, "tg.gw.running") };
}
