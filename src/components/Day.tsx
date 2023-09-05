"use client";

import Task from "@/components/Task";
import { cn } from "@/lib/utils";
import { useMutationState } from "@tanstack/react-query";
import { format, isEqual, isSameMonth, isToday } from "date-fns-jalali";
import { useState } from "react";
import type { ProjectType } from "./Calendar";

import { useDeleteTask, type InsertTask } from "@/app/_hooks/useTasks";
import { Plus, X } from "lucide-react";
import AddTaskDialog from "./AddTaskDialog";
import { Button } from "./ui/button";

export default function Day({
  day,
  selectedDay,
  firstDayCurrentMonth,
  todayTasks,
  projects,
  userId,
}: {
  userId: string;
  day: Date;
  selectedDay: Date;
  projects: ProjectType[] | undefined;
  firstDayCurrentMonth: Date;
  todayTasks: InsertTask[] | undefined;
}) {
  const [tasks, setTasks] = useState(todayTasks);
  const [variable] = useMutationState<InsertTask>({
    filters: { mutationKey: ["addTask"], status: "pending" },
    //@ts-ignore
    select: (mutation) => mutation.state.variables,
  });
  const [value, setValue] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<number>(0);

  const { mutate } = useDeleteTask();

  return (
    <>
      <AddTaskDialog date={day} userId={userId} projectList={projects}>
        <Button
          size="icon"
          variant="secondary"
          className="absolute bottom-1 left-1 h-6 w-6 scale-0 cursor-pointer items-center justify-center rounded-full text-primary transition-all ease-in-out group-hover:flex group-hover:scale-100 "
        >
          <Plus className="absolute" />
        </Button>
      </AddTaskDialog>

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
      <div className="relative flex w-full flex-col gap-1">
        {todayTasks?.map((task) => (
          <div key={task.id} className="group/task">
            {
              <Button
                className="absolute left-0 hidden group-hover/task:inline-block"
                variant="destructive"
                size={"sm"}
                onClick={() => task.id && mutate(task.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            }
            <Task task={task} projects={projects} />
          </div>
        ))}
        {/* {variable && variable.date === format(day, "yyyy-MM-dd") && (
          <Task key={variable.id} projects={projects} task={variable} />
        )} */}
      </div>
    </>
  );
}
