import type { AuthFailureCode } from "./auth-api"

/**
 * Persian copy for auth failures — shown verbatim in the form's error banner.
 * (Client-side localization per the error-model draft: stable codes in, calm
 * Persian out.)
 */
const MESSAGES: Record<AuthFailureCode, string> = {
  EmailAlreadyRegistered: "این ایمیل قبلاً ثبت شده است. وارد شوید.",
  InvalidCredentials: "ایمیل یا گذرواژه درست نیست.",
  RateLimited: "تلاش‌های ناموفق زیاد بود. کمی بعد دوباره تلاش کنید.",
  Unauthorized: "نشست شما پایان یافته است. دوباره وارد شوید.",
  AlreadyInHousehold: "شما در حال حاضر عضو یک خانه هستید.",
  HouseholdFull: "این خانه پر شده است.",
  InviteInvalid: "کد دعوت معتبر نیست.",
  BadRequest: "اطلاعات واردشده کامل یا درست نیست.",
  InternalError: "خطایی رخ داد. لطفاً دوباره تلاش کنید.",
  Network: "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید."
}

export const authErrorMessage = (code: AuthFailureCode): string => MESSAGES[code]
