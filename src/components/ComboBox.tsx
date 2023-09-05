import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import { CommandEmpty, CommandGroup, CommandInput, CommandItem } from "cmdk";
import { Check, Command } from "lucide-react";
import { Dispatch, SetStateAction, useState } from "react";
import { ProjectType } from "./Calendar";
import { Button } from "./ui/button";

export default function ComboBox({
  itemList,
  setSelectedProjectId,
}: {
  itemList: ProjectType[] | undefined;
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
