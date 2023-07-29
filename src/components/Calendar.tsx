"use client";

import Task from "@/components/Task";
import { cn } from "@/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
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

import { useState } from "react";

export default function Calendar() {
  const today = startOfToday();
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

  return (
    <div className="mx-auto flex h-full w-full flex-col px-4 pt-8 font-vazir sm:px-7  md:px-6">
      <div className="flex items-center">
        <h2 className="flex-auto font-semibold text-gray-900">
          {format(firstDayCurrentMonth, "MMMM yyyy")}
        </h2>
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
      <div className="mt-10 grid grid-cols-7 border-b text-center text-lg leading-6 text-gray-500">
        <div className="pb-2 font-semibold">شنبه</div>
        <div className="pb-2 font-semibold">یکشنبه</div>
        <div className="pb-2 font-semibold">دوشنبه</div>
        <div className="pb-2 font-semibold">سه‌شنبه</div>
        <div className="pb-2 font-semibold">چهارشنبه</div>
        <div className="pb-2 font-semibold">پنجشنبه</div>
        <div className="pb-2 font-semibold">جمعه</div>
      </div>
      <div className="grid flex-grow grid-cols-7 gap-0 border text-sm">
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
              "group flex h-full flex-col items-start gap-1 border p-1",
            )}
          >
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
              <time dateTime={format(day, "yyyy-MM-dd")}>
                {format(day, "d")}
              </time>
            </div>
            <div className="flex w-full flex-col gap-1">
              <Task />
              <Task />
            </div>
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
