import { getCurrentUser } from "@/lib/auth";
import { getOrCreateChatChartLayout, listChartLayouts } from "@/lib/store";
import { CHAT_QUERY_KEY, isValidChatId } from "@/lib/chatUrl";
import { SmartChartWorkspace } from "@/components/SmartChartWorkspace";
import { AdModal } from "@/components/ads/AdModal";
import { ChartErrorBoundary } from "@/components/chart/ChartErrorBoundary";
import { SubscribeClient } from "@/components/subscription/SubscribeClient";
import { isLLMConfiguredAsync } from "@/lib/llm";
import { initDb } from "@/lib/db";
import { getEntitlementForUser } from "@/lib/subscription/entitlement";
import { getBillingPlan, getCurrentPlanPrice } from "@/lib/billing/planConfig";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  await initDb();
  const { getOwnerId } = await import("@/lib/ownerIdentity");
  const isOwner = (await getOwnerId()) === user.id;
  const entitlement = await getEntitlementForUser(user);
  const [planPrice, plan] = await Promise.all([getCurrentPlanPrice(), getBillingPlan()]);
  const planFacts = {
    priceCents: planPrice?.price_cents ?? null,
    signupGrantCredits: plan.signup_grant_credits,
  };

  if (!isOwner && entitlement.access === "blocked") {
    return (
      <SubscribeClient
        mode="blocked"
        plan={planFacts}
      />
    );
  }

  // A valid trial gets the FULL workspace — every feature, bounded only by
  // the one-hour clock and the three-recommendation cap enforced server-side.

  // One chart per conversation. A deep link into a chat renders THAT chat's
  // board server-side (no flash of another conversation's drawings); the bare
  // home screen is not a conversation and gets a clean, unsaved chart — only
  // the last-used symbol/interval carry over.
  const rawChat = (await searchParams)[CHAT_QUERY_KEY];
  const chatId = isValidChatId(typeof rawChat === "string" ? rawChat : null)
    ? (rawChat as string)
    : null;
  const recent = (await listChartLayouts(user.id))[0] ?? null;
  const layout = chatId
    ? await getOrCreateChatChartLayout(user.id, chatId, {
        symbol: recent?.symbol,
        interval: recent?.interval,
      })
    : null;
  let initialState: import("@/components/SmartChartWorkspace").ChartLayoutState | null = null;
  try {
    initialState = layout?.state_json ? JSON.parse(layout.state_json) : null;
  } catch {
    initialState = null;
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {/* One ad per session at most; the refusal modal always outranks it. */}
      <AdModal />
      <ChartErrorBoundary>
        <SmartChartWorkspace
          agentReady={await isLLMConfiguredAsync()}
          initialSymbol={layout?.symbol ?? recent?.symbol}
          layoutId={layout?.id}
          initialChatId={chatId}
          initialInterval={layout?.interval ?? recent?.interval}
          initialState={initialState}
        />
      </ChartErrorBoundary>
    </div>
  );
}
