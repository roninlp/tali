import { useMutation, useQuery } from "@tanstack/react-query";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { Database } from "@/types/supabase";
import { format } from "date-fns-jalali";
import getQueryClient from "../getQueryClient";

const supabase = createClientComponentClient<Database>();
const queryClient = getQueryClient();

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

const useTasks = (id: string) => {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchTasks(id),
  });
};

const useAddTask = () => {
  return useMutation({
    mutationFn: async (task: {
      projectId: number;
      date: Date;
      userId: string;
      name: string;
    }) => {
      const formattedDate = format(task.date, "yyyy-MM-dd");
      await supabase.from("tasks").insert({
        project_id: task.projectId,
        date: formattedDate,
        user_id: task.userId,
        title: task.name,
      });
    },
    mutationKey: ["addTask"],
    onSettled: async () => {
      return await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
};

export { useTasks, fetchTasks, useAddTask };
