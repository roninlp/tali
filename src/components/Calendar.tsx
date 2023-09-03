"use client";

// * React and Nextjs stuff
import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useState,
  experimental_useOptimistic as useOptimistic,
} from "react";

import { useRouter } from "next/navigation";

// * database stuff
import { Database } from "@/types/supabase";
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
import { Check, ChevronLeft, ChevronRight, Plus } from "lucide-react";

import Day from "@/components/Day";

import { ThemeToggle } from "./theme-toggle-button";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";

import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchProjects, useProjects } from "@/app/_hooks/useProjects";
import { useAddTask, useTasks } from "@/app/_hooks/useTasks";
import { userAgent } from "next/server";

// * types probably gotta refactor or sth
export type Project = {
  id: number;
  name: string | null;
};

export type TaskType = {
  category_id: number | null;
  created_at: string;
  date: string;
  id: number;
  is_complete: boolean;
  project_id: number;
  title: string | null;
  user_id: string;
};

export default function Calendar({ session }: { session: Session }) {
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

  const { data: projectsList } = useProjects(user.id);

  const { data: tasks } = useTasks(user.id);

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
            <AddTaskDialog
              date={day}
              key={dayIdx}
              userId={user.id}
              projectList={projectsList}
            >
              <Button
                size="icon"
                variant="secondary"
                className="absolute bottom-1 left-1 h-6 w-6 scale-0 cursor-pointer items-center justify-center rounded-full text-primary transition-all ease-in-out group-hover:flex group-hover:scale-100 "
              >
                <Plus className="absolute" />
              </Button>
            </AddTaskDialog>

            <Day
              todayTasks={tasks?.filter(
                (task) => format(day, "yyyy-MM-dd") === task.date,
              )}
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
function AddTaskDialog({
  projectList,
  children,
  date,
  userId,
}: {
  projectList: Project[] | undefined;
  date: Date;
  userId: string;

  children: React.ReactNode;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number>(0);

  const { mutate, isPending, submittedAt, isError, variables } = useAddTask();
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="font-vazir sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>تسک جدید</DialogTitle>
          <DialogDescription>تسک جدید رو اضافه کنید.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="project">نام پروژه:</Label>
            <div className="col-span-3">
              <ComboBox
                setSelectedProjectId={setSelectedProjectId}
                itemList={projectList}
              />
            </div>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="taskName">تسک:</Label>
            <Input
              id={`taskName`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="col-span-3"
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose>
            <Button type="submit">Add Task</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ComboBox({
  itemList,
  setSelectedProjectId,
}: {
  itemList: Project[] | undefined;
  setSelectedProjectId: Dispatch<SetStateAction<number>>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className=" w-full justify-between"
        >
          {value
            ? itemList &&
              itemList.find((project) => project.name === value)?.name
            : "انتخاب پروژه..."}
        </Button>
      </PopoverTrigger>
      <PopoverContent className=" p-0">
        <Command>
          <CommandInput placeholder="جستجوی پروژه..." />
          <CommandEmpty>پروژه‌ای موجود نیست.</CommandEmpty>
          <CommandGroup>
            {itemList &&
              itemList.map((item) => (
                <CommandItem
                  key={item.id}
                  onSelect={(currentValue) => {
                    setValue(currentValue === value ? "" : currentValue);
                    setSelectedProjectId(item.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === item.name ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {item.name}
                </CommandItem>
              ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
