import { ThemeProvider } from "@/components/theme-provider";
import { ReactQueryClientProvider } from "@/components/tanstack-query-provider";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ReactQueryClientProvider>
        {children}
        <div dir="ltr">
          <ReactQueryDevtools />
        </div>
      </ReactQueryClientProvider>
    </ThemeProvider>
  );
}
