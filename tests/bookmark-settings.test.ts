import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<object>(),
  Plugin: class {},
  Modal: class {},
}));
vi.mock("../src/settings-tab", () => ({ OctosyncSettingTab: class {} }));
vi.mock("../src/conflict-modal", () => ({ ConflictResolutionModal: class {} }));

import OctosyncPlugin from "../src/main";
import { MetadataStore } from "../src/metadata";

describe("bookmark settings", () => {
  const configDir = ".custom-config";
  const path = `${configDir}/bookmarks.json`;

  async function setup(settings = {}) {
    let stored: unknown = { settings };
    const plugin = new OctosyncPlugin({} as never, {} as never);
    Object.assign(plugin, {
      app: { vault: { configDir } },
      loadData: vi.fn(async () => structuredClone(stored)),
      saveData: vi.fn(async (data: unknown) => { stored = structuredClone(data); }),
      debugLog: { write: vi.fn() },
    });
    const metadata = new MetadataStore(async () => null, async () => {});
    await metadata.load();
    Object.assign(plugin, { metadata });
    vi.spyOn(plugin, "configureChangeIndicators").mockImplementation(() => {});
    await plugin.loadSettings();
    return { plugin, metadata };
  }

  it("defaults off for existing installations and persists opt-in", async () => {
    const { plugin } = await setup({ syncThemes: true });
    expect(plugin.settings.syncBookmarks).toBe(false);
    await plugin.updateBookmarkSync(true);
    plugin.settings.syncBookmarks = false;
    await plugin.loadSettings();
    expect(plugin.settings.syncBookmarks).toBe(true);
    expect(plugin.settings.syncThemes).toBe(true);
  });

  it("forgets only disabled bookmarks and does not resurrect their tracking on re-enable", async () => {
    const { plugin, metadata } = await setup({ syncBookmarks: true });
    metadata.update(path, { sha: "old", deleted: false }, 1);
    metadata.update("Note.md", { sha: "note", deleted: false }, 1);
    const save = vi.spyOn(metadata, "save");
    await plugin.updateBookmarkSync(false);
    expect(metadata.get(path)).toBeUndefined();
    expect(metadata.get("Note.md")?.sha).toBe("note");
    expect(save).toHaveBeenCalledOnce();
    await plugin.loadSettings();
    expect(plugin.settings.syncBookmarks).toBe(false);
    await plugin.updateBookmarkSync(true);
    expect(metadata.get(path)).toBeUndefined();
    expect(plugin.configureChangeIndicators).toHaveBeenCalledTimes(2);
  });

  it("rejects changing the bookmark policy during an active sync", async () => {
    const { plugin, metadata } = await setup({ syncBookmarks: true });
    metadata.update(path, { sha: "tracked" }, 1);
    vi.spyOn(plugin, "isSyncing").mockReturnValue(true);
    await expect(plugin.updateBookmarkSync(false)).rejects.toThrow(/Wait for the current sync/);
    expect(plugin.settings.syncBookmarks).toBe(true);
    expect(metadata.get(path)?.sha).toBe("tracked");
  });
});
