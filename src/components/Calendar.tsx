"use client";

import Day from "@/components/Day";
import { cn } from "@/lib/utils";
import { Database } from "@/types/supabase";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
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

import { useCallback, useEffect, useState } from "react";

export default function Calendar({ session }: { session: Session | null }) {
  const supabase = createClientComponentClient<Database>();
  const user = session?.user;

  const router = useRouter();

  const today = startOfToday();
  const [newProject, setNewProject] = useState("");
  const [projectsList, setProjectsList] =
    useState<{ id: number; name: string | null }[]>();
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

  async function addTask() {}
  return (
    <div className="font-vazir mx-auto flex h-full w-full flex-col px-8 pt-8">
      <div className="flex items-center gap-2">
        <h2 className="fle flex-auto px-8 font-semibold text-gray-900">
          {format(firstDayCurrentMonth, "MMMM yyyy")}
        </h2>
        <div className="flex">
          <div className="flex gap-2">
            {projectsList?.map((project) => (
              <div
                key={project.id}
                className="group relative flex items-center rounded-md bg-slate-300 px-4"
              >
                <div>{project.name}</div>
                <span
                  onClick={() => deleteProject(project.id)}
                  className="absolute -top-6 right-0 hidden h-6 w-6 cursor-pointer items-center justify-center  bg-red-600 text-center text-xs font-bold text-white group-hover:flex"
                >
                  x
                </span>
              </div>
            ))}
          </div>
          <button
            onClick={addNewProject}
            className="rounded-md bg-red-400 px-1 py-2 text-white"
          >
            Add Project
          </button>
          <input
            type="text"
            name="newProject"
            id="newProject"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            className="border py-0"
          />
        </div>
        <p>{user?.email}</p>
        <button
          className="bg-black px-2 py-1 text-white"
          onClick={handleSignOut}
        >
          SignOut
        </button>
        <div className="flex">
          <button
            onClick={previousMonth}
            className="-my-1.5 flex flex-none items-center justify-center p-1.5 text-gray-400 hover:text-gray-500"
          >
            <span className="sr-only">ماه قبل</span>
            <ChevronRightIcon className="h-5 w-5" />
          </button>
          <button
            onClick={nextMonth}
            className="-my-1.5 flex flex-none items-center justify-center p-1.5 text-gray-400 hover:text-gray-500"
          >
            <span className="sr-only">ماه بعد</span>
            <ChevronLeftIcon className="h-5 w-5" />
          </button>
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
            <div
              onClick={() => console.log("add clicked")}
              className="absolute bottom-1 left-1 hidden h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-xl text-white group-hover:flex"
            >
              +
            </div>
            <Day
              day={day}
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
