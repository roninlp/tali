"use client";

import Task from "@/components/Task";
import { cn } from "@/lib/utils";
import { format, isEqual, isSameMonth, isToday } from "date-fns-jalali";
import type { TaskType, Project } from "./Calendar";
import { useState } from "react";
import { useMutationState } from "@tanstack/react-query";

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
  const [tasks, setTasks] = useState(todayTasks);
  const variables = useMutationState<{
    projectId: number;
    date: Date;
    userId: string;
    name: string;
  }>({
    filters: { mutationKey: ["addTodo"], status: "pending" },
    select: (mutation) => mutation.state.variables,
  });
  return (
    <>
      <div
        className={cn(
          isEqual(day, selectedDay) && "text-secondary-foreground",
          !isEqual(day, selectedDay) && isToday(day) && "text-primary",
          !isEqual(day, selectedDay) && !isToday(day) && "text-foreground",
          !isEqual(day, selectedDay) &&
            !isToday(day) &&
            !isSameMonth(day, firstDayCurrentMonth) &&
            "text-foreground",
          isEqual(day, selectedDay) &&
            isToday(day) &&
            "bg-primary text-primary-foreground",
          isEqual(day, selectedDay) && !isToday(day) && "bg-accent",
          !isEqual(day, selectedDay) && "group-hover:bg-muted",
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
        <Task key={variables[0].name} projects={projects} task={variables[0]}
      </div>
    </>
  );
}
