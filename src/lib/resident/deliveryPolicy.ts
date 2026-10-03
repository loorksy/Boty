/** Pure retry policy for durable events. Redis uses it; tests pin it. */
export function deliveryDisposition(
  deliveries: number,
  maxAttempts = 5,
): "retry" | "dead" {
  if (!Number.isFinite(deliveries) || deliveries < 1) return "retry";
  return deliveries >= maxAttempts ? "dead" : "retry";
}

export function eventMaxAttempts(): number {
  const raw = Number(process.env.GATEWAY_EVENT_MAX_ATTEMPTS || 5);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}
