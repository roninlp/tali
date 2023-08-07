"use client";

import Task from "@/components/Task";
import { cn } from "@/lib/utils";
import { format, isEqual, isSameMonth, isToday, parse } from "date-fns-jalali";
import type { TaskType, Project } from "./Calendar";

export default function Day({
  day,
  selectedDay,
  firstDayCurrentMonth,
  todayTasks,
  projects,
}: {
  day: Date;
  selectedDay: Date;
  projects: Project[] | undefined;
  firstDayCurrentMonth: Date;
  todayTasks: TaskType[] | null | undefined;
}) {
  if (isEqual(day, selectedDay)) {
    console.log(todayTasks);

    todayTasks?.map((task) => {
      console.log(parse(task.date, "yyyy-mm-dd", new Date()));
      console.log(task.created_at);
    });
  }
  return (
    <>
      <div
        className={cn(
          isEqual(day, selectedDay) && "text-white",
          !isEqual(day, selectedDay) && isToday(day) && "text-red-500",
          !isEqual(day, selectedDay) && !isToday(day) && "text-gray-900",
          !isEqual(day, selectedDay) &&
            !isToday(day) &&
            !isSameMonth(day, firstDayCurrentMonth) &&
            "text-gray-400",
          isEqual(day, selectedDay) && isToday(day) && "bg-red-500",
          isEqual(day, selectedDay) && !isToday(day) && "bg-gray-900",
          !isEqual(day, selectedDay) && "group-hover:bg-gray-200",
          (isEqual(day, selectedDay) || isToday(day)) && "font-semibold",
          "flex h-6 w-6 items-center justify-center rounded-full text-sm",
        )}
      >
        <time dateTime={format(day, "yyyy-MM-dd")}>{format(day, "d")}</time>
      </div>
      <div className="flex w-full flex-col gap-1">
        {todayTasks?.map((task) => (
          <Task key={task.id} task={task} projects={projects} />
        ))}
      </div>
    </>
  );
}
