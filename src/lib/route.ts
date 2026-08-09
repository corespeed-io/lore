// Pure URL <-> route-state mapping for the client shell.

export type Tab = "overview" | "graph" | "search" | "agents" | "operations";

export interface RouteState {
  tab: Tab;
  memoryId?: string;
  focusId?: string;
  q?: string;
  type?: string;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodePathSegment);
}

function queryValue(params: URLSearchParams, key: string): string | undefined {
  return params.get(key) ?? undefined;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function parseRoute(pathname: string, search: string): RouteState {
  const params = new URLSearchParams(search);
  const q = queryValue(params, "q");
  const type = queryValue(params, "type");
  const focusId = queryValue(params, "focus");
  const segments = pathSegments(pathname);

  if (segments[0] === "graph") {
    if (segments[1] === "memory") {
      return { tab: "graph", memoryId: segments[2], focusId };
    }
    return { tab: "graph", focusId: segments[1] ?? focusId };
  }

  if (segments[0] === "memories") {
    return { tab: "search", memoryId: segments[1], q, type };
  }

  if (segments[0] === "agents") {
    return { tab: "agents" };
  }

  if (segments[0] === "operations") {
    return { tab: "operations" };
  }

  if (segments[0] === "memory") {
    return { tab: "overview", memoryId: segments[1] };
  }

  const tabParam = params.get("tab");
  const tab: Tab =
    tabParam === "graph" ||
    tabParam === "search" ||
    tabParam === "agents" ||
    tabParam === "operations"
      ? tabParam
      : "overview";
  return {
    tab,
    memoryId: queryValue(params, "memory"),
    focusId,
    q,
    type,
  };
}

export function routeUrl(route: RouteState): string {
  let path = "/";
  if (route.tab === "graph") {
    if (route.memoryId) path = `/graph/memory/${encoded(route.memoryId)}`;
    else if (route.focusId) path = `/graph/${encoded(route.focusId)}`;
    else path = "/graph";
  } else if (route.tab === "search") {
    path = route.memoryId ? `/memories/${encoded(route.memoryId)}` : "/memories";
  } else if (route.tab === "agents") {
    path = "/agents";
  } else if (route.tab === "operations") {
    path = "/operations";
  } else if (route.memoryId) {
    path = `/memory/${encoded(route.memoryId)}`;
  }

  const params = new URLSearchParams();
  if (route.tab === "search" && route.q) params.set("q", route.q);
  if (route.tab === "search" && route.type && route.type !== "all") params.set("type", route.type);
  if (route.tab === "graph" && route.memoryId && route.focusId) params.set("focus", route.focusId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
