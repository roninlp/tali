import Calendar from "@/components/Calendar";
import { Database } from "@/types/supabase";
import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import getQueryClient from "../getQueryClient";
import { fetchProjects } from "../_hooks/useProjects";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const queryClient = getQueryClient();
  const supabase = createServerComponentClient<Database>({ cookies });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    await queryClient.prefetchQuery({
      queryKey: ["projects"],
      queryFn: () => fetchProjects(session.user.id),
    });
    await queryClient.prefetchQuery({
      queryKey: ["tasks"],
    });
  }
  const dehydratedState = dehydrate(queryClient);

  return (
    session && (
      <div className="h-screen">
        <HydrationBoundary state={dehydratedState}>
          <Calendar session={session} />
        </HydrationBoundary>
      </div>
    )
  );
}
