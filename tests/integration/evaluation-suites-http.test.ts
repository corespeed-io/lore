import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "@/server/api/app";
import { createMemoryTestContext } from "../support/memory-context";

afterEach(() => vi.unstubAllEnvs());

test("Evaluation Suites list over HTTP in cursor pages and reject bad page controls", async () => {
  vi.stubEnv("AUTH_MODE", "none");
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("LORE_LOCAL_SUBJECT", "http-evaluation-pager");
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Evaluation paging" }),
    })
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const created: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await app.request("/api/v1/evaluations/suites", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `Paged suite ${index}`,
        cases: [
          {
            query: `question ${index}`,
            expectedMemoryIds: ["40000000-0000-4000-8000-000000000001"],
          },
        ],
      }),
    });
    expect(response.status).toBe(201);
    created.push(((await response.json()) as { id: string }).id);
  }
  const list = (query: string) => app.request(`/api/v1/evaluations/suites${query}`, { headers });

  const first = await list("?limit=2");
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("private, no-store");
  const cursor = first.headers.get("x-lore-next-cursor");
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  const firstPage = (await first.json()) as { id: string }[];
  const second = await list(`?limit=2&cursor=${cursor}`);
  expect(second.status).toBe(200);
  expect(second.headers.get("x-lore-next-cursor")).toBeNull();
  const secondPage = (await second.json()) as { id: string }[];
  // Newest first, every Suite exactly once across the pages.
  expect([...firstPage, ...secondPage].map((suite) => suite.id)).toEqual([...created].reverse());
  // Without controls the default page holds all three and has no successor.
  const whole = await list("");
  expect(whole.headers.get("x-lore-next-cursor")).toBeNull();
  await expect(whole.json()).resolves.toHaveLength(3);

  for (const query of [
    "?limit=0",
    "?limit=101",
    "?limit=two",
    "?cursor=not%20base64",
    "?cursor=e30",
  ]) {
    const response = await list(query);
    expect(response.status, query).toBe(400);
    await expect(response.json(), query).resolves.toMatchObject({ code: "invalid_request" });
  }
});
