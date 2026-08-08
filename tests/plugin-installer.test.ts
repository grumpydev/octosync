import { describe, expect, it } from "vitest";
import { setRequestUrlMock } from "obsidian";
import { installMissingCommunityPlugins } from "../src/plugin-installer";

const CONFIG_DIR = ".obsidian";

// ponytail: minimal adapter fake (text files only) — reuses no obsidian API surface
// beyond what installMissingCommunityPlugins actually calls.
function createFakeVault(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  return {
    configDir: CONFIG_DIR,
    adapter: {
      exists: async (path: string) => store.has(path) || [...store.keys()].some((p) => p.startsWith(`${path}/`)),
      read: async (path: string) => {
        if (!store.has(path)) throw new Error(`Missing file ${path}`);
        return store.get(path)!;
      },
      write: async (path: string, data: string) => {
        store.set(path, data);
      },
      mkdir: async () => {},
    },
    store,
  } as unknown as Parameters<typeof installMissingCommunityPlugins>[0] & { store: Map<string, string> };
}

function textResponse(status: number, text: string) {
  return { status, text, json: null, headers: {} };
}

describe("installMissingCommunityPlugins", () => {
  it("does nothing when no plugins are enabled", async () => {
    const vault = createFakeVault();
    const result = await installMissingCommunityPlugins(vault, CONFIG_DIR);
    expect(result).toEqual({ installed: [], failed: [] });
  });

  it("skips plugins that are already installed locally", async () => {
    const vault = createFakeVault({
      [`${CONFIG_DIR}/community-plugins.json`]: JSON.stringify(["dataview"]),
      [`${CONFIG_DIR}/plugins/dataview/manifest.json`]: JSON.stringify({ id: "dataview", version: "1.0.0" }),
    });

    setRequestUrlMock(async () => {
      throw new Error("should not fetch anything for an already-installed plugin");
    });

    const result = await installMissingCommunityPlugins(vault, CONFIG_DIR);
    expect(result).toEqual({ installed: [], failed: [] });
  });

  it("downloads manifest, main.js, and styles.css for a missing enabled plugin", async () => {
    const vault = createFakeVault({
      [`${CONFIG_DIR}/community-plugins.json`]: JSON.stringify(["dataview"]),
    });

    setRequestUrlMock(async (request) => {
      if (request.url.endsWith("/obsidian-releases/HEAD/community-plugins.json")) {
        return textResponse(200, JSON.stringify([{ id: "dataview", repo: "blacksmithgu/obsidian-dataview" }]));
      }
      if (request.url.endsWith("/blacksmithgu/obsidian-dataview/HEAD/manifest.json")) {
        return textResponse(200, JSON.stringify({ id: "dataview", version: "0.5.68" }));
      }
      if (request.url.endsWith("/releases/download/0.5.68/main.js")) {
        return textResponse(200, "console.log('main');");
      }
      if (request.url.endsWith("/releases/download/0.5.68/styles.css")) {
        return textResponse(200, "body{}");
      }
      return textResponse(404, "");
    });

    const result = await installMissingCommunityPlugins(vault, CONFIG_DIR);

    expect(result).toEqual({ installed: ["dataview"], failed: [] });
    expect(vault.store.get(`${CONFIG_DIR}/plugins/dataview/main.js`)).toBe("console.log('main');");
    expect(vault.store.get(`${CONFIG_DIR}/plugins/dataview/styles.css`)).toBe("body{}");

    setRequestUrlMock(null);
  });

  it("installs without styles.css when the plugin doesn't ship one", async () => {
    const vault = createFakeVault({
      [`${CONFIG_DIR}/community-plugins.json`]: JSON.stringify(["no-styles"]),
    });

    setRequestUrlMock(async (request) => {
      if (request.url.endsWith("/obsidian-releases/HEAD/community-plugins.json")) {
        return textResponse(200, JSON.stringify([{ id: "no-styles", repo: "owner/no-styles" }]));
      }
      if (request.url.endsWith("/owner/no-styles/HEAD/manifest.json")) {
        return textResponse(200, JSON.stringify({ id: "no-styles", version: "1.0.0" }));
      }
      if (request.url.endsWith("/releases/download/1.0.0/main.js")) {
        return textResponse(200, "console.log('main');");
      }
      return textResponse(404, "");
    });

    const result = await installMissingCommunityPlugins(vault, CONFIG_DIR);

    expect(result).toEqual({ installed: ["no-styles"], failed: [] });
    expect(vault.store.has(`${CONFIG_DIR}/plugins/no-styles/styles.css`)).toBe(false);

    setRequestUrlMock(null);
  });

  it("reports a failure when the plugin isn't found in the registry", async () => {
    const vault = createFakeVault({
      [`${CONFIG_DIR}/community-plugins.json`]: JSON.stringify(["unknown-plugin"]),
    });

    setRequestUrlMock(async (request) => {
      if (request.url.endsWith("/obsidian-releases/HEAD/community-plugins.json")) {
        return textResponse(200, JSON.stringify([]));
      }
      return textResponse(404, "");
    });

    const result = await installMissingCommunityPlugins(vault, CONFIG_DIR);
    expect(result).toEqual({ installed: [], failed: ["unknown-plugin"] });

    setRequestUrlMock(null);
  });
});
