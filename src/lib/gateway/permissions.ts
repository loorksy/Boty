/**
 * Tool risk classes for the private agent.
 *
 * TRADE_EXECUTION is refused unconditionally. No goal, schedule, sub-agent,
 * or market watcher can place or modify a financial order. The only order
 * path that exists is the explicit human confirmation layer, and this module
 * does not import it.
 */

export const RISK_CLASSES = [
  "READ",
  "INTERNAL_WRITE",
  "NOTIFY",
  "EXTERNAL_WRITE",
  "TRADE_EXECUTION",
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

const TRADE_TOOLS = new Set([
  "execute_trade",
  "place_order",
  "modify_order",
  "close_position",
  "cancel_order",
  "submit_order",
  "metaapi_order",
  "broker_order",
]);

const TRADE_PREFIXES = [
  "execute_",
  "place_order",
  "modify_order",
  "close_position",
  "submit_order",
  "cancel_order",
];

export class TradeBoundaryError extends Error {
  readonly code = "TRADE_EXECUTION_FORBIDDEN";
  constructor(tool: string) {
    super(`Autonomous trade execution is forbidden (${tool}).`);
    this.name = "TradeBoundaryError";
  }
}

export class ToolPermissionError extends Error {
  readonly code = "TOOL_PERMISSION_DENIED";
  constructor(tool: string) {
    super(`Tool is not on this agent's allowlist (${tool}).`);
    this.name = "ToolPermissionError";
  }
}

export class ApprovalRequiredError extends Error {
  readonly code = "APPROVAL_REQUIRED";
  constructor(tool: string) {
    super(`External write requires owner approval (${tool}).`);
    this.name = "ApprovalRequiredError";
  }
}

export function isTradeExecutionTool(name: string): boolean {
  const tool = name.trim().toLowerCase();
  if (!tool) return false;
  if (TRADE_TOOLS.has(tool)) return true;
  return TRADE_PREFIXES.some((prefix) => tool.startsWith(prefix));
}

export function riskForTool(name: string): RiskClass {
  if (isTradeExecutionTool(name)) return "TRADE_EXECUTION";
  const tool = name.trim().toLowerCase();
  if (tool.startsWith("notify") || tool === "send_telegram" || tool === "send_message") {
    return "NOTIFY";
  }
  if (
    tool.startsWith("write_") ||
    tool.startsWith("create_goal") ||
    tool.startsWith("update_goal") ||
    tool === "delegate"
  ) {
    return "INTERNAL_WRITE";
  }
  if (tool.startsWith("external_") || tool.includes("webhook_out")) return "EXTERNAL_WRITE";
  return "READ";
}

export interface ToolPolicy {
  allowlist: readonly string[];
  allowNotify: boolean;
  allowExternalWrite: boolean;
}

export function assertToolPermitted(tool: string, policy: ToolPolicy): RiskClass {
  if (isTradeExecutionTool(tool)) throw new TradeBoundaryError(tool);
  if (!policy.allowlist.includes(tool)) throw new ToolPermissionError(tool);
  const risk = riskForTool(tool);
  if (risk === "TRADE_EXECUTION") throw new TradeBoundaryError(tool);
  if (risk === "EXTERNAL_WRITE" && !policy.allowExternalWrite) {
    throw new ApprovalRequiredError(tool);
  }
  if (risk === "NOTIFY" && !policy.allowNotify) throw new ToolPermissionError(tool);
  return risk;
}

/**
 * External content is data. It cannot rewrite the policy object.
 * The returned policy is the same reference the caller passed in.
 */
export function policyAfterExternalContent(policy: ToolPolicy, content: string): ToolPolicy {
  void quarantineExternalContent(content);
  return policy;
}

/** Wrap untrusted text so a model sees it as data, not as instructions. */
export function quarantineExternalContent(text: string): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return `<untrusted_data>\n${cleaned}\n</untrusted_data>`;
}
