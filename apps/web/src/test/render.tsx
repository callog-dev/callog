import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ConfirmProvider } from "@/components/confirm";

/** Renders inside the app's providers at `url`; `location()` reads where the page navigated. */
export function renderPage(ui: ReactNode, url = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const seen = { current: url };
  function Spy() {
    const location = useLocation();
    seen.current = location.pathname + location.search;
    return null;
  }
  const result = render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[url]}>
          {ui}
          <Spy />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { ...result, location: () => seen.current };
}
