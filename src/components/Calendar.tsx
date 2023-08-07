"use client";

import Day from "@/components/Day";
import { cn } from "@/lib/utils";
import { Database } from "@/types/supabase";
import { Check, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  Session,
  createClientComponentClient,
} from "@supabase/auth-helpers-nextjs";
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
import { useRouter } from "next/navigation";

import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { ThemeToggle } from "./theme-toggle-button";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "./ui/command";

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

export default function Calendar({ session }: { session: Session | null }) {
  const supabase = createClientComponentClient<Database>();
  const user = session?.user;

  const router = useRouter();

  const today = startOfToday();
  const [newProject, setNewProject] = useState("");
  const [projectsList, setProjectsList] = useState<Project[]>();
  const [tasks, setAllTasks] = useState<TaskType[] | null>();

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

  const getProjects = useCallback(async () => {
    try {
      const { data, error, status } = await supabase
        .from("projects")
        .select("name, id")
        .eq("user_id", user?.id);

      if (error && status !== 406) {
        throw error;
      }

      if (data) {
        setProjectsList(data);
      }
    } catch (error) {
      alert("error Loading user data");
    }
  }, [user, supabase]);

  const getTasks = useCallback(async () => {
    try {
      const { data, error, status } = await supabase
        .from("tasks")
        .select("*")
        .eq("user_id", user?.id);

      if (error && status !== 406) {
        throw error;
      }

      if (data) {
        setAllTasks(data);
      }
    } catch (error) {
      alert("error loading tasks");
    }
  }, [user, supabase]);

  async function addNewProject() {
    try {
      if (user) {
        const { error } = await supabase
          .from("projects")
          .insert({ name: newProject, user_id: user.id });
        if (error) throw error;
        getProjects();
        setNewProject("");
      }
    } catch (error) {
      console.error(error);
      alert("error adding new project");
    }
  }

  useEffect(() => {
    getProjects();
    console.log("get project ran");
  }, [user, getProjects]);

  useEffect(() => {
    getTasks();
    console.log("tasks ran");
  }, [user, getTasks]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.refresh();
  }

  async function deleteProject(id: number) {
    try {
      if (user) {
        await supabase.from("projects").delete().eq("id", id);
        getProjects();
      }
    } catch (error) {
      console.log(error);
      alert("error deleting project");
    }
  }

  async function addTask(task: {
    projectId: number;
    name?: string;
    date: Date;
  }) {
    const formattedDate = format(task.date, "yyyy-mm-dd");
    try {
      if (user) {
        await supabase.from("tasks").insert({
          project_id: task.projectId,
          date: formattedDate,
          user_id: user?.id,
          title: task.name,
        });
      }
    } catch (error) {
      console.log(error);
    }
  }

  return (
    <div className="mx-auto flex h-full w-full flex-col px-8 pt-8 font-vazir">
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <h2 className="flex-auto px-8 font-semibold text-gray-900 dark:text-white">
          {format(firstDayCurrentMonth, "MMMM yyyy")}
        </h2>
        <div className="flex">
          <div className="flex gap-2">
            {projectsList?.map((project) => (
              <Button variant="link" key={project.id}>
                <div>{project.name}</div>
                <span
                  onClick={() => deleteProject(project.id)}
                  className="absolute -top-6 right-0 hidden h-6 w-6 cursor-pointer items-center justify-center  bg-red-600 text-center text-xs font-bold text-white group-hover:flex"
                >
                  x
                </span>
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={addNewProject}>Add Project</Button>
            <Input
              type="text"
              name="newProject"
              id="newProject"
              placeholder="نام پروژه"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              className="border py-0"
            />
          </div>
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
        <div className="pb-2 font-semibold">Sat</div>
        <div className="pb-2 font-semibold">Sun</div>
        <div className="pb-2 font-semibold">Mon</div>
        <div className="pb-2 font-semibold">Tue</div>
        <div className="pb-2 font-semibold">Wed</div>
        <div className="pb-2 font-semibold">Thu</div>
        <div className="pb-2 font-semibold">Fri</div>
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
              addTask={addTask}
              date={day}
              projectList={projectsList}
            >
              <Plus
                onClick={() => console.log("add clicked")}
                className="absolute bottom-1 left-1 hidden h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-xl text-white group-hover:flex"
              />
            </AddTaskDialog>

            <Day
              todayTasks={tasks}
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

function AddTaskDialog({
  projectList,
  children,
  date,
  addTask,
}: {
  projectList: Project[] | undefined;
  date: Date;
  addTask: (task: {
    projectId: number;
    name?: string;
    date: Date;
  }) => Promise<void>;
  children: React.ReactNode;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    null,
  );

  return (
    <Dialog open={open}>
      <DialogTrigger onClick={() => setOpen(true)} asChild>
        {children}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
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
              id="taskName"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="col-span-3"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="submit"
            onClick={() => {
              selectedProjectId &&
                addTask({
                  date: date,
                  projectId: selectedProjectId,
                  name: value,
                });
              setOpen(false);
            }}
          >
            Add Task
          </Button>
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
  setSelectedProjectId: Dispatch<SetStateAction<number | null>>;
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
          className="w-[200px] justify-between"
        >
          {value
            ? itemList &&
              itemList.find((project) => project.name === value)?.name
            : "انتخاب پروژه"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
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
