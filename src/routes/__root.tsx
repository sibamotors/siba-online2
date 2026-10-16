import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { LocalSessionProvider } from "@/lib/local-session";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "description", content: APP_TAGLINE },
      { name: "theme-color", content: "#111111" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "apple-touch-icon", href: "/logo.png" },
    ],
  }),
  component: RootDocument,
});

function handleQueryError(error: unknown) {
  if (typeof window === "undefined") return;
  if (error instanceof Error && error.message.includes("AUTH_REQUIRED") && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
}

function RootDocument() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleQueryError }),
        defaultOptions: {
          queries: { staleTime: 8_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  const [lang, setLang] = useState<"fa" | "en">("fa");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("sibamotor-lang") as "fa" | "en";
      if (saved === "en" || saved === "fa") {
        setLang(saved);
      }
    } catch {
      // ignore
    }
  }, []);

  return (
    <html lang={lang} dir={lang === "fa" ? "rtl" : "ltr"} suppressHydrationWarning data-theme="ink" data-accent="blue" data-font="vazirmatn" data-scheme="dark">
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        <LocalSessionProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <Outlet />
              <Toaster position="top-center" dir={lang === "fa" ? "rtl" : "ltr"} richColors />
            </ThemeProvider>
          </QueryClientProvider>
        </LocalSessionProvider>
        <Scripts />
      </body>
    </html>
  );
}
