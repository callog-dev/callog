import "@fontsource-variable/geist";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app";
import { Toaster } from "./components/ui/sonner";
import { ApiError } from "./lib/api";
import { TooltipProvider } from "./components/ui/tooltip";
import "./index.css";

/** A 401 anywhere means the session expired: refetching `me` brings up the login page. */
const onUnauthorized = (error: unknown, queryKey?: readonly unknown[]) => {
  if (error instanceof ApiError && error.status === 401 && queryKey?.[0] !== "me") {
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  }
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
  queryCache: new QueryCache({ onError: (error, query) => onUnauthorized(error, query.queryKey) }),
  mutationCache: new MutationCache({ onError: (error) => onUnauthorized(error) }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <Toaster richColors />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
