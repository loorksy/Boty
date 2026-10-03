import Link from "next/link";
import { headers } from "next/headers";
import { PublicChrome } from "@/components/landing/PublicChrome";
import { isRegistrationOpen } from "@/lib/auth/registration";
import { detectLocale, t } from "@/lib/i18n";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata("signup");

export default async function SignupPage() {
  const h = await headers();
  const locale = detectLocale(h.get("accept-language"));
  const registrationOpen = await isRegistrationOpen();
  return (
    <PublicChrome skipTargetId="auth-main" registrationOpen={registrationOpen}>
      <main id="auth-main" className="mx-auto max-w-lg px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-white">{t(locale, "signup.closed_title")}</h1>
        <p className="mt-3 text-white/70">{t(locale, "signup.closed_body")}</p>
        <Link
          href="/login"
          className="mt-8 inline-flex min-h-10 items-center rounded-full border border-white/20 px-5 text-sm text-white"
        >
          {t(locale, "signup.go_login")}
        </Link>
      </main>
    </PublicChrome>
  );
}
