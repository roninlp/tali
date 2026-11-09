/**
 * Persian copy for a durable sync failure marker, ported from
 * `apps/web/src/lib/sync-copy.ts`.
 *
 * `InvalidPatch`/`ValidationError` cannot succeed by resending, so the copy
 * points at the data. `UniqueViolation` can converge from the mirror's current
 * version. `AttributionLimit` is unknown, so one retry is worth a shot.
 * `Forbidden` normally never becomes a marker (the engine drops the row).
 */
const MESSAGES = {
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
  VisibilityFixed:
    'این مورد همیشه همان چیزی است که خط‌مشی تعیین می‌کند؛ نیازی به تغییر دستی نیست.',
  VisibilityForbidden: 'فقط سازنده‌ی این مورد می‌تواند آن را خصوصی کند.',
  VisibilityInherited:
    'این مورد از فهرست یا عادت والد پیروی می‌کند؛ والد را تغییر دهید.',
} satisfies Record<string, string>

const hasMessage = (code: string): code is keyof typeof MESSAGES =>
  Object.hasOwn(MESSAGES, code)

const FALLBACK =
  'این تغییر روی سرور ذخیره نشد. اتصال را بررسی کنید و دوباره تلاش کنید.'

export const syncFailureMessage = (code: string): string =>
  hasMessage(code) ? MESSAGES[code] : FALLBACK
