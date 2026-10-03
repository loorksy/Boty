/**
 * Host-facing gateway status. Failures stay visible on the health payload.
 */
import { buildGatewayStatus } from "./status";
import { recordGatewayHeartbeat } from "./runtime";

export { recordGatewayHeartbeat };

export async function buildGatewayStatusSafe(input: {
  uptimeMs?: number | null;
  queueBackend?: string;
  queuePending?: number | null;
  queueInFlight?: number | null;
}): Promise<unknown> {
  try {
    return await buildGatewayStatus(input);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
