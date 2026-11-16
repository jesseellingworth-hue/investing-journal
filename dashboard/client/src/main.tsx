// Cloudflare client entrypoint — replaces the Muse main.tsx:
// a plain QueryClient (no spaceQueryClient), a normal #root mount
// (no data-generated-space-root element, no hatch-space-root shell
// classes). Safe-area insets come from the CSS env() spacer in
// App.tsx and the tailwindcss-safe-area utilities in theme.css.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const queryClient = new QueryClient();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
