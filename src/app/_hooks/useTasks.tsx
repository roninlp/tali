import { TaskType } from "@/components/Calendar";
import { Database, InsertTables } from "@/types/supabase";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
//import getQueryClient from "../getQueryClient";

const supabase = createClientComponentClient<Database>();

export type InsertTask = InsertTables<"tasks">;

const fetchTasks = async (id: string) => {
  try {
    const { data, error, status } = await supabase
      .from("tasks")
      .select("*")
      .eq("user_id", id);

    if (error && status !== 406) {
      throw new Error("error fetching tasks");
    }

    if (data) {
      return data;
    }
  } catch (error) {
    console.log("error Loading user data");
  }
};

const useTasks = (id: string, initialTasks?: TaskType[]) => {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchTasks(id),
    initialData: initialTasks,
  });
};

const useAddTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ project_id, date, user_id, title }: InsertTask) => {
      await supabase.from("tasks").insert({
        project_id: project_id,
        date: date,
        user_id: user_id,
        title: title,
      });
    },
    onSuccess: async () => {
      return await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onSettled: async () => {
      return await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    mutationKey: ["addTask"],
  });
};

const useDeleteTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: number) => {
      await supabase.from("tasks").delete().eq("id", taskId);
    },
    onSettled: async () =>
      await queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
};

export { fetchTasks, useAddTask, useDeleteTask, useTasks };

