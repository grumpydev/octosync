import { describe, expect, it } from "vitest";
import { buildEffectiveSettings, isSelfBinding } from "../src/binding-sync";
import { createBinding } from "../src/vault-registry";
import { DEFAULT_SETTINGS } from "../src/types";

describe("buildEffectiveSettings", () => {
  const global = {
    ...DEFAULT_SETTINGS,
    token: "global-token",
    syncCommunityPlugins: true,
    syncThemes: true,
    syncBookmarks: false,
    syncVaultExcludePaths: ["global-only"],
  };

  it("merges a self binding from legacy settings", () => {
    const binding = createBinding({
      vaultPath: "",
      owner: "alice",
      repo: "notes",
      branch: "main",
      syncBookmarks: true,
      excludePaths: ["Private"],
    });

    const effective = buildEffectiveSettings(global, binding, true);
    expect(effective.owner).toBe("alice");
    expect(effective.repo).toBe("notes");
    expect(effective.branch).toBe("main");
    expect(effective.token).toBe("global-token");
    expect(effective.syncBookmarks).toBe(true);
    expect(effective.syncVaultExcludePaths).toEqual(["Private"]);
    // Self bindings keep the global community-plugin installation behavior.
    expect(effective.syncCommunityPlugins).toBe(true);
    // Global exclude patterns are untouched.
    expect(effective.syncExcludePaths).toEqual(global.syncExcludePaths);
  });

  it("falls back to the global token and disables plugin installation for arms", () => {
    const binding = createBinding({
      name: "arm",
      vaultPath: "C:/Notes/Work",
      owner: "bob",
      repo: "work",
      branch: "main",
    });

    const effective = buildEffectiveSettings(global, binding, false);
    expect(effective.token).toBe("global-token");
    expect(effective.syncCommunityPlugins).toBe(false);
    expect(effective.syncThemes).toBe(true);
  });

  it("prefers a per-binding token override", () => {
    const binding = createBinding({
      vaultPath: "C:/Notes/Work",
      owner: "bob",
      repo: "work",
      branch: "main",
      token: "arm-token",
    });

    expect(buildEffectiveSettings(global, binding, false).token).toBe("arm-token");
  });

  it("does not leak binding excludes into the global settings object", () => {
    const binding = createBinding({
      vaultPath: "C:/Notes/Work",
      owner: "bob",
      repo: "work",
      branch: "main",
      excludePaths: ["ArmOnly"],
    });

    buildEffectiveSettings(global, binding, false);
    expect(global.syncVaultExcludePaths).toEqual(["global-only"]);
  });
});

describe("isSelfBinding", () => {
  it("treats the sentinel path as self regardless of the hub path", () => {
    expect(isSelfBinding(createBinding({ vaultPath: "" }), "C:/Hub")).toBe(true);
  });

  it("treats other paths as arms", () => {
    expect(isSelfBinding(createBinding({ vaultPath: "C:/Other" }), "C:/Hub")).toBe(false);
  });
});
