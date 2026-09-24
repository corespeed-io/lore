import { expect, test } from "vitest";
import { PLAINTEXT_PROVIDER_HOSTS, providerBaseUrl } from "@/server/providers/environment";

test("provider base URLs allow plain HTTP only on loopback and the Docker-host bridge", () => {
  expect([...PLAINTEXT_PROVIDER_HOSTS]).toEqual([
    "127.0.0.1",
    "localhost",
    "[::1]",
    "host.docker.internal",
  ]);
  for (const url of [
    "http://127.0.0.1:8000/v1",
    "http://localhost:8080",
    "http://LOCALHOST:8080",
    "http://[::1]:8000",
    "http://host.docker.internal:11434",
    "https://reranker.example.com",
  ]) {
    expect(providerBaseUrl(url, "test base URL").href, url).toBe(new URL(url).href);
  }
});

test.each([
  "http://reranker.example.com",
  "http://10.0.0.5:8000",
  "http://127.0.0.2:8000",
  "http://[::2]:8000",
  "http://localhost.example.com",
  "http://host.docker.internal.example.com",
])("provider base URLs reject plain HTTP to %s", (url) => {
  expect(() => providerBaseUrl(url, "test base URL")).toThrow(
    "test base URL must use https outside loopback or host.docker.internal",
  );
});

test("a credential-free self-hosted surface may opt out of HTTPS but not out of http(s)", () => {
  expect(
    providerBaseUrl("http://planner.internal:8000/v1", "test base URL", { requireHttps: false })
      .href,
  ).toBe("http://planner.internal:8000/v1");
  for (const url of ["ftp://127.0.0.1/", "file:///etc/passwd", "ws://localhost:8000"]) {
    expect(() => providerBaseUrl(url, "test base URL"), url).toThrow(
      "test base URL must use http or https",
    );
    expect(() => providerBaseUrl(url, "test base URL", { requireHttps: false }), url).toThrow(
      "test base URL must use http or https",
    );
  }
});

test("an unparseable provider base URL fails without echoing it", () => {
  expect(() =>
    providerBaseUrl("https://operator:embedded-secret@[not-a-host", "test base URL"),
  ).toThrow(/^test base URL must be an absolute http or https URL$/);
});
