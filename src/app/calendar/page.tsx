import Calendar from "@/components/Calendar";
import { Database } from "@/types/supabase";
import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";
import { fetchProjects } from "../_hooks/useProjects";
import { fetchTasks } from "../_hooks/useTasks";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  //const queryClient = getQueryClient();
  const supabase = createServerComponentClient<Database>({ cookies });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  // if (session?.user) {
  //   await queryClient.prefetchQuery({
  //     queryKey: ["projects"],
  //     queryFn: () => fetchProjects(session.user.id),
  //   });
  //   await queryClient.prefetchQuery({
  //     queryKey: ["tasks"],
  //   });
  // }
  //const dehydratedState = dehydrate(queryClient);
  if (session?.user) {
    const initialProjects = await fetchProjects(session.user.id);
    const initialTasks = await fetchTasks(session.user.id);

    return (
      session &&
      initialProjects &&
      initialTasks && (
        <div className="h-screen">
          <Calendar
            session={session}
            initialProjects={initialProjects}
            initialTasks={initialTasks}
          />
        </div>
      )
    );
  }
}
