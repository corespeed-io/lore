import { expect, test } from "vitest";
import { loadConfig } from "../src/lib/config.js";

test("defaults are applied when env is empty", () => {
  const c = loadConfig({});
  expect(c.appTitle).toBe("Memory for humans and agents");
  expect(c.appSubtitle).toMatch(/workspaces/);
  expect(c.authMode).toBe("none");
});

test("invalid AUTH_MODE remains invalid instead of downgrading to none", () => {
  expect(loadConfig({ AUTH_MODE: "bogus" }).authMode).toBe("invalid");
});

test("branding passes through", () => {
  const c = loadConfig({ APP_TITLE: "Team memory", APP_SUBTITLE: "Remember together." });
  expect(c.appTitle).toBe("Team memory");
  expect(c.appSubtitle).toBe("Remember together.");
});
