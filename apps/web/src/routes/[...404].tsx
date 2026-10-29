import { Icon } from "../components/icons"

export default function NotFound() {
  return (
    <main
      dir="rtl"
      lang="fa"
      class="grid min-h-dvh place-items-center bg-base-200 px-4 text-base-content"
    >
      <section class="card w-full max-w-sm border border-base-300 bg-base-100 shadow-xl">
        <div class="card-body items-center gap-3 text-center">
          <span class="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Icon name="search" class="size-6" />
          </span>
          <h1 class="m-0 text-2xl font-bold">صفحه پیدا نشد</h1>
          <p class="m-0 text-sm text-base-content/55">نشانی‌ای که باز کردید وجود ندارد.</p>
          <a href="/" class="btn btn-primary btn-sm mt-1">
            بازگشت به تالی
          </a>
        </div>
      </section>
    </main>
  )
}
