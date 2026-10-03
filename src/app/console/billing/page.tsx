import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ownerCostSummary } from "@/lib/gateway/costs";
import { t } from "@/lib/i18n";
import { resolveUserLocale } from "@/lib/i18n/userLocale";

export const metadata = { title: "Operator cost" };

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/console/billing");
  const locale = await resolveUserLocale(user.id);
  const costs = await ownerCostSummary();
  return (
    <main className="page-shell max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">{t(locale, "billing.owner_costs_title")}</h1>
      <p className="text-sm text-muted-foreground">{t(locale, "billing.owner_costs_body")}</p>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t(locale, "control.today")}</dt>
          <dd className="text-2xl font-semibold">${costs.todayUsd.toFixed(4)}</dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t(locale, "control.month")}</dt>
          <dd className="text-2xl font-semibold">${costs.monthUsd.toFixed(4)}</dd>
        </div>
      </dl>
    </main>
  );
}
