import { t } from "@/lib/i18n";

/** Legacy platform-config key. Ignored: public registration stays closed. */
export const REGISTRATION_OPEN_KEY = "REGISTRATION_OPEN";

/** Stable machine code on every closed-registration refusal (never a 500). */
export const REGISTRATION_CLOSED_CODE = "REGISTRATION_CLOSED";

/**
 * Public registration is permanently closed. This is a private single-owner
 * agent; the old REGISTRATION_OPEN toggle cannot create another account.
 */
export async function isRegistrationOpen(): Promise<boolean> {
  return false;
}

export class RegistrationClosedError extends Error {
  readonly code = REGISTRATION_CLOSED_CODE;
  readonly status = 403;
  constructor(message?: string) {
    super(message ?? t("ar", "auth.registration_closed"));
    this.name = "RegistrationClosedError";
  }
}

export function isRegistrationClosedError(
  err: unknown,
): err is RegistrationClosedError {
  return (
    !!err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: string }).name === "RegistrationClosedError"
  );
}

export async function assertRegistrationOpen(): Promise<void> {
  if (await isRegistrationOpen()) return;
  throw new RegistrationClosedError();
}
