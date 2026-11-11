import { describe, expect, it } from "vitest";
import {
  createBinding,
  ensureSelfBinding,
  findBinding,
  getSelfBinding,
  migrateLegacyToBindings,
  normalizeVaultFolderPath,
  validateBinding,
} from "../src/vault-registry";
import { DEFAULT_SETTINGS, type OctosyncSettings } from "../src/types";

function makeSettings(overrides: Partial<OctosyncSettings> = {}): OctosyncSettings {
  // bindings gets a fresh array each time: DEFAULT_SETTINGS' nested arrays are
  // shared across spread copies, which would leak bindings between tests.
  return { ...DEFAULT_SETTINGS, bindings: [], ...overrides };
}

describe("vault registry", () => {
  describe("normalizeVaultFolderPath", () => {
    it("normalizes windows and posix paths", () => {
      expect(normalizeVaultFolderPath("C:\\Notes\\My Vault\\")).toBe("C:/Notes/My Vault");
      expect(normalizeVaultFolderPath("/Users/me/Vaults/notes/")).toBe("/Users/me/Vaults/notes");
      expect(normalizeVaultFolderPath("  /srv/vault ")).toBe("/srv/vault");
    });

    it("rejects unusable paths", () => {
      expect(normalizeVaultFolderPath("")).toBeNull();
      expect(normalizeVaultFolderPath("relative/vault")).toBeNull();
      expect(normalizeVaultFolderPath("C:\\")).toBeNull();
      expect(normalizeVaultFolderPath("//server")).toBeNull();
    });
  });

  describe("migration", () => {
    it("creates a self binding from legacy settings", () => {
      const settings = makeSettings({
        owner: "alice",
        repo: "notes",
        branch: "main",
        token: "legacy-token",
        syncBookmarks: true,
        syncVaultExcludePaths: ["Private"],
      });

      expect(migrateLegacyToBindings(settings)).toBe(true);
      const self = getSelfBinding(settings.bindings);
      expect(self).toBeDefined();
      expect(self?.owner).toBe("alice");
      expect(self?.repo).toBe("notes");
      expect(self?.branch).toBe("main");
      expect(self?.enabled).toBe(true);
      expect(self?.excludePaths).toEqual(["Private"]);
    });

    it("is a no-op when bindings already exist", () => {
      const settings = makeSettings({ owner: "a", repo: "b", branch: "c" });
      settings.bindings = [createBinding({ name: "arm", vaultPath: "/tmp/vault" })];
      const before = settings.bindings.length;

      expect(migrateLegacyToBindings(settings)).toBe(false);
      expect(settings.bindings.length).toBe(before);
    });

    it("creates a disabled self binding when no repository is configured", () => {
      const settings = makeSettings();
      migrateLegacyToBindings(settings);
      expect(getSelfBinding(settings.bindings)?.enabled).toBe(false);
    });
  });

  describe("ensureSelfBinding", () => {
    it("mirrors legacy settings into the self binding on every save", () => {
      const settings = makeSettings({ owner: "a", repo: "b", branch: "c" });
      const self = ensureSelfBinding(settings);
      expect(self.owner).toBe("a");

      settings.owner = "someone-else";
      settings.repo = "other";
      settings.branch = "dev";
      ensureSelfBinding(settings);
      expect(self.owner).toBe("someone-else");
      expect(self.repo).toBe("other");
      expect(self.branch).toBe("dev");

      // ensureSelfBinding must never create a second self binding.
      expect(settings.bindings.filter((b) => b.vaultPath === "").length).toBe(1);
    });
  });

  describe("validateBinding", () => {
    const arm = createBinding({
      name: "work notes",
      vaultPath: "C:\\Notes\\Work",
      owner: "alice",
      repo: "work",
      branch: "main",
    });

    it("accepts a complete arm binding", () => {
      expect(validateBinding(arm, [arm])).toEqual([]);
    });

    it("flags missing repository fields", () => {
      const incomplete = createBinding({ name: "x", vaultPath: "/tmp/v", owner: "a", repo: "", branch: "" });
      const problems = validateBinding(incomplete, [incomplete]);
      expect(problems.some((problem) => problem.includes("repository"))).toBe(true);
      expect(problems.some((problem) => problem.includes("branch"))).toBe(true);
    });

    it("flags a missing vault path for arms", () => {
      const noPath = createBinding({ name: "x", vaultPath: "", owner: "a", repo: "b", branch: "c" });
      const problems = validateBinding(noPath, [noPath], { requireVaultPath: true });
      expect(problems.some((problem) => problem.includes("absolute vault folder path"))).toBe(true);
    });

    it("flags relative vault paths for arms", () => {
      const relative = createBinding({ name: "x", vaultPath: "relative/vault", owner: "a", repo: "b", branch: "c" });
      const problems = validateBinding(relative, [relative], { requireVaultPath: true });
      expect(problems.some((problem) => problem.includes("absolute folder path"))).toBe(true);
    });

    it("does not require a path when editing the plugin's own vault binding", () => {
      const self = createBinding({ name: "self", vaultPath: "", owner: "a", repo: "b", branch: "c" });
      const problems = validateBinding(self, [self]);
      expect(problems).toEqual([]);
    });

    it("flags duplicate repository targets across enabled arms", () => {
      const twin = createBinding({
        name: "twin",
        vaultPath: "/tmp/other",
        owner: "alice",
        repo: "work",
        branch: "main",
      });
      const problems = validateBinding(twin, [arm, twin], { requireVaultPath: true });
      expect(problems.some((problem) => problem.includes("already syncs"))).toBe(true);
    });

    it("flags duplicate vault folders across arms", () => {
      const twin = createBinding({
        name: "same folder",
        vaultPath: "c:/notes/work/",
        owner: "alice",
        repo: "elsewhere",
        branch: "main",
      });
      const problems = validateBinding(twin, [arm, twin], { requireVaultPath: true });
      expect(problems.some((problem) => problem.includes("already points at this vault folder"))).toBe(true);
    });

    it("flags an arm that points at the hub's own vault folder", () => {
      const hub = createBinding({
        name: "oops",
        vaultPath: "C:/Hub/Vault",
        owner: "alice",
        repo: "hub",
        branch: "main",
      });
      const problems = validateBinding(hub, [hub], {
        requireVaultPath: true,
        hubVaultPath: "c:\\hub\\vault",
      });
      expect(problems.some((problem) => problem.includes("hub's own vault"))).toBe(true);
    });
  });

  it("finds bindings by id", () => {
    const binding = createBinding({ name: "a" });
    const bindings = [binding];
    expect(findBinding(bindings, binding.id)).toBe(binding);
    expect(findBinding(bindings, "missing")).toBeUndefined();
  });
});
