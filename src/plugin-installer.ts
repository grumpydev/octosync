import type { Vault } from "obsidian";
import { requestUrl } from "obsidian";
import type { DebugLogSink } from "./debug-log";

// ponytail: mirrors Obsidian's own plugin installer (manifest from the repo's HEAD,
// assets from the matching GitHub release) instead of vendoring a registry client
// or adding a dependency. If the registry format changes, update here.
const REGISTRY_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";

interface RegistryEntry {
  id: string;
  repo: string;
}

interface PluginManifest {
  id: string;
  version: string;
}

export interface PluginInstallResult {
  installed: string[];
  failed: string[];
}

/**
 * Installs any community plugin that is listed as enabled in community-plugins.json
 * but whose code is missing locally (e.g. after syncing to a new device). Never
 * touches a plugin's data.json, so credentials already stored there are unaffected.
 */
export async function installMissingCommunityPlugins(
  vault: Vault,
  configDir: string,
  debugLog?: DebugLogSink,
): Promise<PluginInstallResult> {
  const result: PluginInstallResult = { installed: [], failed: [] };
  const enabledIds = await readEnabledPluginIds(vault, configDir);

  const missingIds: string[] = [];
  for (const id of enabledIds) {
    if (!(await vault.adapter.exists(`${configDir}/plugins/${id}/manifest.json`))) {
      missingIds.push(id);
    }
  }
  if (missingIds.length === 0) {
    return result;
  }

  let registry: RegistryEntry[];
  try {
    registry = JSON.parse(await fetchText(REGISTRY_URL)) as RegistryEntry[];
  } catch (error) {
    debugLog?.("plugin-install.registry-failed", { error: String(error) });
    return { installed: [], failed: missingIds };
  }

  for (const id of missingIds) {
    const entry = registry.find((candidate) => candidate.id === id);
    if (!entry) {
      result.failed.push(id);
      debugLog?.("plugin-install.not-found", { id });
      continue;
    }

    try {
      await installPlugin(vault, configDir, entry.repo);
      result.installed.push(id);
    } catch (error) {
      result.failed.push(id);
      debugLog?.("plugin-install.failed", { id, repo: entry.repo, error: String(error) });
    }
  }

  return result;
}

async function installPlugin(vault: Vault, configDir: string, repo: string): Promise<void> {
  const manifestText = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`);
  const manifest = JSON.parse(manifestText) as PluginManifest;
  const pluginDir = `${configDir}/plugins/${manifest.id}`;

  if (!(await vault.adapter.exists(pluginDir))) {
    await vault.adapter.mkdir(pluginDir);
  }

  const releaseBase = `https://github.com/${repo}/releases/download/${manifest.version}`;
  await vault.adapter.write(`${pluginDir}/manifest.json`, manifestText);
  await vault.adapter.write(`${pluginDir}/main.js`, await fetchText(`${releaseBase}/main.js`));

  try {
    await vault.adapter.write(`${pluginDir}/styles.css`, await fetchText(`${releaseBase}/styles.css`));
  } catch {
    // styles.css is optional; not every plugin ships one.
  }
}

async function readEnabledPluginIds(vault: Vault, configDir: string): Promise<string[]> {
  const path = `${configDir}/community-plugins.json`;
  if (!(await vault.adapter.exists(path))) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(await vault.adapter.read(path));
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await requestUrl({ url, throw: false });
  if (response.status !== 200) {
    throw new Error(`Request to ${url} failed with status ${response.status}`);
  }
  return response.text;
}
