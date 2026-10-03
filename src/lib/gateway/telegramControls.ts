/**
 * Mechanical Telegram controls. Free text is not parsed here; responsibility
 * language is absorbed separately and still reaches Lonora.
 */
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

export async function handleGatewayTelegramCommand(text: string): Promise<GatewayCommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const command = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (command === "/status") {
    const status = await buildGatewayStatus();
    return {
      text: [
        `Gateway ${status.status}`,
        `queue ${status.queue.backend}`,
        `redis ${status.redis.configured ? "up" : "not configured"}`,
        `active goals ${status.goals.active}`,
        `failed tasks ${status.tasks.failed ?? 0}`,
        status.failures.length ? `failures ${status.failures.join(", ")}` : "failures none",
      ].join("\n"),
    };
  }
  if (command === "/tasks") {
    const tasks = await listTasks({ limit: 8 });
    if (!tasks.length) return { text: "No tasks." };
    return {
      text: tasks.map((task) => `${task.status} ${task.role} ${task.id.slice(0, 8)}`).join("\n"),
    };
  }
  if (command === "/goals") {
    const goals = await listGoals();
    if (!goals.length) return { text: "No goals." };
    return {
      text: goals.slice(0, 8).map((goal) => `${goal.status} ${goal.kind} ${goal.title}`).join("\n"),
    };
  }
  if (command === "/agents") {
    const agents = await listSubAgents(8);
    if (!agents.length) return { text: "No sub-agents." };
    return {
      text: agents.map((agent) => `${agent.status} ${agent.role}`).join("\n"),
    };
  }
  if (command === "/pause") {
    const id = argOf(trimmed);
    if (id) {
      const goal = await pauseGoal(id);
      return { text: goal ? `Paused ${goal.title}` : "Goal not found." };
    }
    await setGatewayPaused(true);
    return { text: "Gateway paused. Conversations still work. Monitoring is stopped." };
  }
  if (command === "/resume") {
    const id = argOf(trimmed);
    if (id) {
      const goal = await resumeGoal(id);
      return { text: goal ? `Resumed ${goal.title}` : "Goal not found." };
    }
    await setGatewayPaused(false);
    return { text: "Gateway resumed." };
  }
  if (command === "/paused") {
    return { text: (await isGatewayPaused()) ? "paused" : "running" };
  }
  return null;
}
