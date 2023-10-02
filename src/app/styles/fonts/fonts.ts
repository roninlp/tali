import localFont from "next/font/local";
const Vazir = localFont({
  src: [
    {
      path: "./Vazirmatn-FD-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./Vazirmatn-FD-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./Vazirmatn-FD-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./Vazirmatn-FD-Bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  display: "block",
  variable: "--font-vazir",
});

export { Vazir };
