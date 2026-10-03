import { headers } from "next/headers";
import {
  PUBLIC_MAIN_PAD,
  PublicChrome,
} from "@/components/landing/PublicChrome";
import { detectLocale, t } from "@/lib/i18n";
import { pageMetadata } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const metadata = pageMetadata("pricing");

export default async function PricingPage() {
  const h = await headers();
  const locale = detectLocale(h.get("accept-language"));
  return (
    <PublicChrome skipTargetId="pricing-main" showFooter>
      <main
        id="pricing-main"
        tabIndex={-1}
        className={cn(PUBLIC_MAIN_PAD, "mx-auto max-w-3xl sm:pb-20")}
      >
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white sm:text-4xl">
            {t(locale, "pricing.private_title")}
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-white/60">
            {t(locale, "pricing.private_body")}
          </p>
        </div>
      </main>
    </PublicChrome>
  );
}
