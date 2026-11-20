import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const basepath =
    typeof process !== "undefined" && process.env?.TSS_ROUTER_BASEPATH
      ? process.env.TSS_ROUTER_BASEPATH
      : typeof window !== "undefined" && window.location.pathname.startsWith("/SwasthyaLekh")
        ? "/SwasthyaLekh"
        : undefined;

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    basepath,
  });

  return router;
};
