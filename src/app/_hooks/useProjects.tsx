import { ProjectType } from "@/components/Calendar";
import { Database } from "@/types/supabase";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { useQuery } from "@tanstack/react-query";

const supabase = createClientComponentClient<Database>();

const fetchProjects = async (id: string) => {
  try {
    const { data, error, status } = await supabase
      .from("projects")
      .select("*")
      .eq("user_id", id);

    if (error && status !== 406) {
      throw error;
    }

    if (data) {
      return data;
    }
  } catch (error) {
    console.log("error Loading user data");
  }
};

const useProjects = (id: string, initialProjects?: ProjectType[]) => {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(id),
    initialData: initialProjects,
  });
};

// const addNewProjectMutation = useMutation({
//   mutationFn: async (newPrj) =>
//     await supabase.from("projects").insert({ name: newPrj, user_id: user.id }),
// });

export { fetchProjects, useProjects };
