"use client";

import Day from "@/components/Day";
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
    <div className="mx-auto flex h-full w-full flex-col px-8 pt-8 font-vazir">
      <div className="flex items-center">
        <h2 className="fle flex-auto px-8 font-semibold text-gray-900">
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
              "group flex h-full flex-col items-start gap-1 border-b p-1",
            )}
          >
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
