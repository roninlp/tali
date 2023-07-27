import Calendar from "@/components/Calendar";

export default function Home() {
  return (
    <>
      <header className="border-b px-8 pb-2 pt-4 text-2xl text-black shadow-md">
        Tali
      </header>
      <main dir="rtl" className="">
        <Calendar />
      </main>
    </>
  );
}
