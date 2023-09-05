"use client";

// * React and Nextjs stuff
import { useState } from "react";

import { useRouter } from "next/navigation";

// * database stuff
import { Database, Tables } from "@/types/supabase";
import {
  Session,
  createClientComponentClient,
} from "@supabase/auth-helpers-nextjs";

// * date-fns stuff
import {
  add,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDay,
  isEqual,
  isSameMonth,
  isToday,
  parse,
  startOfToday,
  startOfWeek,
} from "date-fns-jalali";

// * componens
import { ChevronLeft, ChevronRight } from "lucide-react";

import Day from "@/components/Day";

import { ThemeToggle } from "./theme-toggle-button";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useProjects } from "@/app/_hooks/useProjects";
import { useTasks } from "@/app/_hooks/useTasks";
import { cn } from "@/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";

// * types probably gotta refactor or sth

export type ProjectType = Tables<"projects">;
export type TaskType = Tables<"tasks">;

export default function Calendar({
  session,
  initialProjects,
  initialTasks,
}: {
  session: Session;
  initialProjects: ProjectType[];
  initialTasks: TaskType[];
}) {
  const supabase = createClientComponentClient<Database>();
  const user = session.user;

  const queryClient = useQueryClient();

  const router = useRouter();

  const today = startOfToday();
  const [newProject, setNewProject] = useState("");
  //const [projectsList, setProjectsList] = useState<Project[]>();
  //const [tasks, setAllTasks] = useState<TaskType[] | null>();

  const [selectedDay, setSelectedDay] = useState(today);
  const [currentMonth, setCurrentMonth] = useState(format(today, "MMM-yyyy"));
  const firstDayCurrentMonth = parse(currentMonth, "MMM-yyyy", new Date());

  const days = eachDayOfInterval({
    start: startOfWeek(firstDayCurrentMonth),
    end: endOfWeek(endOfMonth(firstDayCurrentMonth)),
  });

  function previousMonth() {
    const firstDayNextMonth = add(firstDayCurrentMonth, { months: -1 });
    setCurrentMonth(format(firstDayNextMonth, "MMM-yyyy"));
  }

  function nextMonth() {
    const firstDayNextMonth = add(firstDayCurrentMonth, { months: 1 });
    setCurrentMonth(format(firstDayNextMonth, "MMM-yyyy"));
  }

  // TODO: Refactor and put all the db functions in a different file probably
  // const getProjects = useCallback(async () => {
  //   try {
  //     const { data, error, status } = await supabase
  //       .from("projects")
  //       .select("name, id")
  //       .eq("user_id", user?.id);

  //     if (error && status !== 406) {
  //       throw error;
  //     }

  //     if (data) {
  //       setProjectsList(data);
  //     }
  //   } catch (error) {
  //     alert("error Loading user data");
  //   }
  // }, [user, supabase]);

  const { data: projectsList } = useProjects(user.id, initialProjects);

  const { data: tasks } = useTasks(user.id, initialTasks);

  // const getTasks = useCallback(async () => {
  //   try {
  //     const { data, error, status } = await supabase
  //       .from("tasks")
  //       .select("*")
  //       .eq("user_id", user?.id);

  //     if (error && status !== 406) {
  //       throw error;
  //     }

  //     if (data) {
  //       setAllTasks(data);
  //     }
  //   } catch (error) {
  //     alert("error loading tasks");
  //   }
  // }, [user, supabase]);

  const addNewProject = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("projects")
        .insert({ name: newProject, user_id: user.id });
      if (error) throw error;
      setNewProject("");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  // async function addNewProject() {
  //   try {
  //     if (user) {
  //       const { error } = await supabase
  //         .from("projects")
  //         .insert({ name: newProject, user_id: user.id });
  //       if (error) throw error;
  //       setNewProject("");
  //     }
  //   } catch (error) {
  //     console.error(error);
  //     alert("error adding new project");
  //   }
  // }

  // useEffect(() => {
  //   getTasks();
  //   console.log("get tasks ran");
  // }, [user, getTasks]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.refresh();
  }

  async function deleteProject(id: number) {
    try {
      if (user) {
        await supabase.from("projects").delete().eq("id", id);
      }
    } catch (error) {
      console.log(error);
      alert("error deleting project");
    }
  }

  // async function addTask(task: {
  //   projectId: number;
  //   name?: string;
  //   date: Date;
  // }) {
  //   const formattedDate = format(task.date, "yyyy-MM-dd");
  //   try {
  //     if (user) {
  //       await supabase.from("tasks").insert({
  //         project_id: task.projectId,
  //         date: formattedDate,
  //         user_id: user?.id,
  //         title: task.name,
  //       });
  //       queryClient.invalidateQueries({ queryKey: ["tasks"] });
  //     }
  //   } catch (error) {
  //     console.log(error);
  //   }
  // }

  return (
    <div className="mx-auto flex h-full w-full flex-col px-8 pt-8 font-vazir">
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <h2 className="flex-auto px-8 font-semibold text-gray-900 dark:text-white">
          {format(firstDayCurrentMonth, "MMMM yyyy")}
        </h2>
        <div className="flex gap-4">
          <div className="flex gap-2">
            {projectsList?.map((project) => (
              <Button
                className="group relative"
                variant="secondary"
                key={project.id}
              >
                <div>{project.name}</div>
                {/* 
                  //TODO: temporary delete button, later add this feature to the project page 
                */}
                <span
                  onClick={() => deleteProject(project.id)}
                  className="absolute -top-6 right-0 hidden h-6 w-6 cursor-pointer items-center justify-center bg-destructive text-center text-xs font-bold text-destructive-foreground group-hover:flex"
                >
                  x
                </span>
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addNewProject.mutate();
            }}
          >
            <Button className="" type="submit">
              Add Project
            </Button>
            <Input
              type="text"
              name="newProject"
              placeholder="نام پروژه"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              className="border py-0"
            />
          </form>
        </div>
        <p>{user?.email}</p>
        <Button variant="outline" onClick={handleSignOut}>
          SignOut
        </Button>
        <div className="flex">
          <Button onClick={previousMonth} variant="ghost" size="icon">
            <span className="sr-only">ماه قبل</span>
            <ChevronRight />
          </Button>
          <Button onClick={nextMonth} variant="ghost" size="icon">
            <span className="sr-only">ماه بعد</span>
            <ChevronLeft />
          </Button>
        </div>
      </div>
      <div className="mt-10 grid grid-cols-7 border-b text-center text-lg leading-6 text-gray-500">
        {weekDays.map((weekDay) => (
          <div key={weekDay} className="pb-2 font-semibold">
            {weekDay}
          </div>
        ))}
      </div>
      <div className="grid flex-grow grid-cols-7 gap-0 text-sm">
        {days.map((day, dayIdx) => (
          <div
            key={day.toString()}
            onClick={() => setSelectedDay(day)}
            className={cn(
              dayIdx === 0 && colStartClasses[getDay(day)],
              !isEqual(day, selectedDay) &&
                !isToday(day) &&
                !isSameMonth(day, firstDayCurrentMonth) &&
                "opacity-30",
              "group relative flex h-full flex-col items-start gap-1 border-b p-1",
            )}
          >
            <Day
              todayTasks={tasks?.filter(
                (task) => format(day, "yyyy-MM-dd") === task.date,
              )}
              userId={user.id}
              day={day}
              projects={projectsList}
              selectedDay={selectedDay}
              firstDayCurrentMonth={firstDayCurrentMonth}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const colStartClasses = [
  "col-start-2",
  "col-start-3",
  "col-start-4",
  "col-start-5",
  "col-start-6",
  "col-start-7",
  "",
];

const weekDays = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

// * Dialog component stuff
// TODO: refactor and move to another file later
