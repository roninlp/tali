"use client";

import { useState } from "react";
import type { TaskType, Project } from "./Calendar";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { cn } from "@/lib/utils";
export default function Task({
  task: { is_complete, title, category_id, project_id },
  projects,
}: {
  task: TaskType;
  projects: Project[] | undefined;
}) {
  const projectName = projects?.find((prj) => prj.id === project_id)?.name;
  const [isDone, setIsDone] = useState(false);
  return (
    <div
      className={cn(
        isDone
          ? "bg-muted text-muted-foreground"
          : "bg-primary text-primary-foreground",
        "w-full rounded-md  px-1 text-lg  transition-all sm:gap-1 md:text-sm lg:gap-8",
      )}
    >
      <div className="flex items-center justify-between gap-0 truncate px-1">
        <div className="flex items-center justify-center gap-1">
          <Checkbox
            id="task"
            checked={isDone}
            onClick={() => setIsDone((prevIsDone) => !prevIsDone)}
          />
          <Label
            htmlFor="task"
            className={cn(
              isDone && "line-through",
              "whitespace-nowrap p-1 leading-4",
            )}
          >
            {projectName}
          </Label>
        </div>
        <span>1/10</span>
      </div>
    </div>
  );
}
