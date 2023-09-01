import { Vazir } from "@/app/styles/fonts/fonts";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TaLi App",
  description: "Project Manager",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        dir="rtl"
        className={`${inter.className} ${Vazir.variable} debug-screens`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
