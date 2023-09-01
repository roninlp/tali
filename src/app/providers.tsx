import { ThemeProvider } from "@/components/theme-provider";
import { ReactQueryClientProvider } from "@/components/tanstack-query-provider";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ReactQueryClientProvider>{children}</ReactQueryClientProvider>
    </ThemeProvider>
  );
}
