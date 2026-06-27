// Pure URL <-> route-state mapping for the SPA router. No React/DOM deps, so it
// is unit-testable in isolation.

export type Tab = "overview" | "graph" | "search" | "requests" | "agents" | "jobs" | "calibration";

// Admin console sections (gbrain admin surfaces). Self-gating: each fails closed
// server-side unless admin mode is configured. Live in the same shell as the
// read surfaces (overview/graph/search) — one unified console.
export const ADMIN_TABS: readonly Tab[] = ["requests", "agents", "jobs", "calibration"];

export interface RouteState {
  tab: Tab;
  page?: string;
  focus?: string;
  q?: string;
  type?: string;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (_) {
    return segment;
  }
}

export function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodePathSegment);
}

function slugFromSegments(segments: string[]): string | undefined {
  return segments.length > 0 ? segments.join("/") : undefined;
}

export function slugPath(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}

function queryValue(params: URLSearchParams, key: string): string | undefined {
  return params.get(key) ?? undefined;
}

export function parseRoute(pathname: string, search: string): RouteState {
  const params = new URLSearchParams(search);
  const q = queryValue(params, "q");
  const type = queryValue(params, "type");
  const focus = queryValue(params, "focus");
  const segments = pathSegments(pathname);

  if (segments[0] === "graph") {
    if (segments[1] === "page") {
      return {
        tab: "graph",
        page: slugFromSegments(segments.slice(2)),
        focus,
      };
    }
    return {
      tab: "graph",
      focus: slugFromSegments(segments.slice(1)) ?? focus,
    };
  }

  if (segments[0] === "memories") {
    return {
      tab: "search",
      page: slugFromSegments(segments.slice(1)),
      q,
      type,
    };
  }

  if (segments[0] === "page") {
    return {
      tab: "overview",
      page: slugFromSegments(segments.slice(1)),
    };
  }

  if (segments[0] && (ADMIN_TABS as readonly string[]).includes(segments[0])) {
    return { tab: segments[0] as Tab };
  }

  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "graph" || tabParam === "search" ? tabParam : "overview";
  return {
    tab,
    page: queryValue(params, "page"),
    focus,
    q,
    type,
  };
}

export function routeUrl(route: RouteState): string {
  if ((ADMIN_TABS as readonly string[]).includes(route.tab)) return `/${route.tab}`;
  let path = "/";
  if (route.tab === "graph") {
    if (route.page) path = `/graph/page/${slugPath(route.page)}`;
    else if (route.focus) path = `/graph/${slugPath(route.focus)}`;
    else path = "/graph";
  } else if (route.tab === "search") {
    path = route.page ? `/memories/${slugPath(route.page)}` : "/memories";
  } else if (route.page) {
    path = `/page/${slugPath(route.page)}`;
  }

  const params = new URLSearchParams();
  if (route.tab === "search" && route.q) params.set("q", route.q);
  if (route.tab === "search" && route.type && route.type !== "all") {
    params.set("type", route.type);
  }
  if (route.tab === "graph" && route.page && route.focus) params.set("focus", route.focus);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
