import { useAddTask } from "@/app/_hooks/useTasks";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@radix-ui/react-dialog";
import { Label } from "@radix-ui/react-label";
import { format } from "date-fns-jalali";
import { useState } from "react";
import { ProjectType } from "./Calendar";
import ComboBox from "./ComboBox";
import { buttonVariants } from "./ui/button";
import { DialogFooter, DialogHeader } from "./ui/dialog";
import { Input } from "./ui/input";

export default function AddTaskDialog({
  projectList,
  children,
  date,
  userId,
}: {
  projectList: ProjectType[] | undefined;
  date: Date;
  userId: string;

  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<number>(0);
  const formattedDate = format(date, "yyyy-MM-dd");

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
          {isPending && <div>Pending</div>}
        </div>
        <DialogFooter>
          <DialogClose
            className={buttonVariants()}
            type="submit"
            onClick={(e) => {
              mutate({
                date: formattedDate,
                project_id: selectedProjectId,
                user_id: userId,
                title: value,
              });
            }}
          >
            Add Task
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
