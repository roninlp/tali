/**
 * Persian copy for a durable sync failure marker.
 *
 * Retry policy per server code (also written down in
 * `docs/sync-protocol-draft.md` §4.4):
 *
 * - `InvalidPatch` / `ValidationError`: resending the same bytes cannot help;
 *   the copy points at the data so the user changes it before retrying.
 * - `UniqueViolation`: the server row moved or is owned by another row now; a
 *   retry anchored at the mirror's current version can converge.
 * - `AttributionLimit`: the server could not attribute the constraint inside
 *   its isolation budget, so the cause is unknown; one retry is worth a shot.
 * - `Forbidden` is handled by the engine's 403 path (the entry and its mirror
 *   row are dropped as no longer visible) and normally never becomes a marker.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  InvalidPatch:
    "سرور این تغییر را معتبر ندانست. متن یا برچسب‌ها را اصلاح کنید و دوباره تلاش کنید.",
  ValidationError:
    "سرور این تغییر را معتبر ندانست. متن یا برچسب‌ها را اصلاح کنید و دوباره تلاش کنید.",
  UniqueViolation:
    "نسخه‌ی سرور این مورد تغییر کرده است. با تلاش دوباره از نسخه‌ی فعلی همگام می‌شود.",
  AttributionLimit:
    "سرور نتوانست این تغییر را پردازش کند. یک‌بار دیگر تلاش کنید.",
  Forbidden: "دسترسی به این مورد تغییر کرده است؛ دیگر روی این دستگاه قابل ویرایش نیست."
}

const FALLBACK = "این تغییر روی سرور ذخیره نشد. اتصال را بررسی کنید و دوباره تلاش کنید."

export const syncFailureMessage = (code: string): string => MESSAGES[code] ?? FALLBACK
