/**
 * Persian copy for a durable sync failure marker, ported from
 * `apps/web/src/lib/sync-copy.ts`.
 *
 * `InvalidPatch`/`ValidationError` cannot succeed by resending, so the copy
 * points at the data. `UniqueViolation` can converge from the mirror's current
 * version. `AttributionLimit` is unknown, so one retry is worth a shot.
 * `Forbidden` normally never becomes a marker (the engine drops the row).
 */
const MESSAGES: Readonly<Record<string, string>> = {
  InvalidPatch:
    'سرور این تغییر را معتبر ندانست. متن یا برچسب‌ها را اصلاح کنید و دوباره تلاش کنید.',
  ValidationError:
    'سرور این تغییر را معتبر ندانست. متن یا برچسب‌ها را اصلاح کنید و دوباره تلاش کنید.',
  UniqueViolation:
    'نسخه‌ی سرور این مورد تغییر کرده است. با تلاش دوباره از نسخه‌ی فعلی همگام می‌شود.',
  AttributionLimit:
    'سرور نتوانست این تغییر را پردازش کند. یک‌بار دیگر تلاش کنید.',
  Forbidden:
    'دسترسی به این مورد تغییر کرده است؛ دیگر روی این دستگاه قابل ویرایش نیست.',
}

const FALLBACK =
  'این تغییر روی سرور ذخیره نشد. اتصال را بررسی کنید و دوباره تلاش کنید.'

export const syncFailureMessage = (code: string): string =>
  MESSAGES[code] ?? FALLBACK
