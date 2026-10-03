import { ControlCenter } from "@/components/gateway/ControlCenter";
import { buildGatewayStatus } from "@/lib/gateway/status";

export default async function ControlPage() {
  const status = await buildGatewayStatus();
  return <ControlCenter initial={status} />;
}
