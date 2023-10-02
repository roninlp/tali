import Calendar from "@/components/Calendar";
import { AuthCard } from "@supabase/auth-ui-react";
import AuthForm from "./auth-form";

export default function Home() {
  return (
    <>
      <main className="flex h-screen items-center justify-center">
        <AuthForm />
      </main>
    </>
  );
}
