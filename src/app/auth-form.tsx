"use client";

import { Database } from "@/types/supabase";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { Auth, SignIn, SignUp } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";

function getURL() {
  let url =
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_VERCEL_URL ??
    "http://localhost:3000/";
  url = url.includes("http") ? url : `https://${url}`;

  url = url.charAt(url.length - 1) === "/" ? url : `${url}/`;
  return url;
}

export default function AuthForm() {
  const supabase = createClientComponentClient<Database>();
  const siteURL = getURL();
  return (
    <div className="flex">
      <Auth
        supabaseClient={supabase}
        view="sign_in"
        appearance={{ theme: ThemeSupa }}
        theme="dark"
        showLinks={false}
        providers={["github"]}
        redirectTo={`${siteURL}auth/callback`}
      />
      {/* <SignIn
        supabaseClient={supabase}
        providers={[]}
        theme="dark"
        appearance={{ theme: ThemeSupa }}
        redirectTo={`${siteURL}auth/callback`}
      /> */}
      {/* <SignUp
        supabaseClient={supabase}
        providers={[]}
        redirectTo={`${siteURL}auth/callback`}
      /> */}
    </div>
  );
}
