"use client";

import { Database } from "@/types/supabase";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { Auth } from "@supabase/auth-ui-react";
import { ThemeMinimal } from "@supabase/auth-ui-shared";

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
    <Auth
      supabaseClient={supabase}
      view="magic_link"
      appearance={{ theme: ThemeMinimal }}
      theme="dark"
      showLinks={false}
      providers={[]}
      redirectTo={`${siteURL}auth/callback`}
    />
  );
}
