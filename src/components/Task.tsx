import type { TaskType, Project } from "./Calendar";
export default function Task({
  task: { is_complete, title, category_id, project_id },
  projects,
}: {
  task: TaskType;
  projects: Project[] | undefined;
}) {
  const projectName = projects?.find((prj) => prj.id === project_id)?.name;
  return (
    <div className=" w-full  rounded-md bg-blue-300 px-1 text-xs sm:gap-1 md:text-sm lg:gap-8">
      <div className="flex items-center justify-between gap-0 truncate px-1">
        <span className="whitespace-nowrap p-1 leading-4">{projectName}</span>
        <span>1/10</span>
      </div>
    </div>
  );
}
