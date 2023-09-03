import { useMutation, useQuery } from "@tanstack/react-query";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { Database } from "@/types/supabase";

const supabase = createClientComponentClient<Database>();

const fetchProjects = async (id: string) => {
  try {
    const { data, error, status } = await supabase
      .from("projects")
      .select("name, id")
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

const useProjects = (id: string) => {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(id),
  });
};

// const addNewProjectMutation = useMutation({
//   mutationFn: async (newPrj) =>
//     await supabase.from("projects").insert({ name: newPrj, user_id: user.id }),
// });

export { useProjects, fetchProjects };
