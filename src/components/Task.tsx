"use client";

import { cn } from "@/lib/utils";
import type { ProjectType } from "./Calendar";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";

import { useToggleTasks, type InsertTask } from "@/app/_hooks/useTasks";

export default function Task({
  task: { id, is_complete, title, category_id, project_id },
  projects,
}: {
  // TODO: Probably use context or something to manage state instead of prop drilling
  task: InsertTask;
  projects: ProjectType[] | undefined;
}) {
  const projectName = projects?.find((prj) => prj.id === project_id)?.name;
  //const [isDone, setIsDone] = useState(is_complete);

  const { mutate } = useToggleTasks();

  const handleToggleTask = () => {
    //setIsDone((prevIsDone) => !prevIsDone);
    if (id) {
      mutate({ taskId: id, isCompleted: is_complete });
    }
  };

  return id ? (
    <div
      className={cn(
        is_complete
          ? "bg-muted text-muted-foreground"
          : "bg-primary text-primary-foreground",
        "w-full rounded-md  px-1 text-lg  transition-all sm:gap-1 md:text-sm lg:gap-8",
      )}
    >
      <div className="flex items-center justify-between gap-0 truncate px-1">
        <div className="flex items-center justify-center gap-1">
          <Checkbox
            id={id.toString()}
            checked={is_complete}
            onClick={handleToggleTask}
          />
          <Label
            htmlFor={id.toString()}
            className={cn(
              is_complete && "line-through",
              "truncate whitespace-nowrap p-1 leading-4",
            )}
          >
            {title}
          </Label>
        </div>

        <span>1/10</span>
      </div>
    </div>
  ) : (
    <div
      className={cn(
        "w-full rounded-md bg-primary px-1 text-lg text-primary-foreground opacity-50  transition-all sm:gap-1 md:text-sm lg:gap-8",
      )}
    >
      <div className="flex items-center justify-between gap-0 truncate px-1">
        <div className="flex items-center justify-center gap-1">
          <Checkbox id="temp" checked={is_complete} />
          <Label
            htmlFor="temp"
            className={cn(
              is_complete && "line-through",
              "cursor-pointer whitespace-nowrap p-1 leading-4",
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
