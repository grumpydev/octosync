import { Notice } from "obsidian";
import type { FileManager, Vault } from "obsidian";
import { createAuthProvider } from "./auth";
import type { DebugLogSink } from "./debug-log";
import { GitHubClient } from "./github";
import { MetadataStore } from "./metadata";
import { NodeFsFileManager } from "./node-vault";
import type { NodeFsVault } from "./node-vault";
import { SyncConflictError, SyncManager, type ConflictResolution, type SyncProgress } from "./sync";
import type { OctosyncSettings, SyncSummary, VaultBinding } from "./types";
import { SELF_VAULT_PATH } from "./vault-registry";

/**
 * The slice of plugin capability the binding runner needs. Implemented by
 * OctosyncPlugin in main.ts; tests can supply a stub.
 */
export interface BindingHost {
  vault: Vault;
  fileManager: FileManager;
  getSettings(): OctosyncSettings;
  /** Persists a binding (replacing the stored copy with the same id) plus its settings mirror. */
  persistBinding(binding: VaultBinding): Promise<void>;
  loadMetadataSlot(bindingId: string): Promise<unknown>;
  saveMetadataSlot(bindingId: string, metadata: unknown): Promise<void>;
  debugLog: DebugLogSink;
  /** Absolute path of the vault running the plugin, or null on mobile. */
  getHubVaultPath(): string | null;
  /** Desktop-only: opens (and rescans) a filesystem vault for an arm binding. */
  openArmVault(binding: VaultBinding): Promise<NodeFsVault>;
  getBindingConflicts(bindingId: string): string[] | null;
  setBindingConflicts(bindingId: string, conflicts: string[] | null): void;
}

export interface BindingRunResult {
  bindingId: string;
  bindingName: string;
  ok: boolean;
  kind: "synced" | "simulated" | "conflict" | "skipped" | "failed";
  summary: SyncSummary | null;
  conflicts: string[];
  message: string;
}

/** Merges global settings with a binding into the effective settings for one sync. */
export function buildEffectiveSettings(global: OctosyncSettings, binding: VaultBinding, isSelf: boolean): OctosyncSettings {
  return {
    ...global,
    owner: binding.owner,
    repo: binding.repo,
    branch: binding.branch,
    token: binding.token || global.token,
    syncBookmarks: binding.syncBookmarks,
    syncVaultExcludePaths: [...binding.excludePaths],
    // Community plugin installation writes into the plugin vault only.
    syncCommunityPlugins: isSelf ? global.syncCommunityPlugins : false,
  };
}

export function isSelfBinding(binding: VaultBinding, hubVaultPath: string | null): boolean {
  return binding.vaultPath === SELF_VAULT_PATH;
}

interface BindingRunner {
  manager: SyncManager;
  metadata: MetadataStore;
  effective: OctosyncSettings;
  armVault: NodeFsVault | null;
}

async function createBindingRunner(
  host: BindingHost,
  binding: VaultBinding,
): Promise<BindingRunner> {
  const isSelf = isSelfBinding(binding, host.getHubVaultPath());
  const effective = buildEffectiveSettings(host.getSettings(), binding, isSelf);
  const github = new GitHubClient(createAuthProvider(effective), host.debugLog);

  let vault: Vault;
  let fileManager: FileManager;
  let armVault: NodeFsVault | null = null;

  if (isSelf) {
    vault = host.vault;
    fileManager = host.fileManager;
  } else {
    armVault = await host.openArmVault(binding);
    vault = armVault as unknown as Vault;
    fileManager = new NodeFsFileManager(armVault) as unknown as FileManager;
  }

  const metadata = new MetadataStore(
    async () => await host.loadMetadataSlot(binding.id),
    async (metadata) => {
      await host.saveMetadataSlot(binding.id, metadata);
    },
  );
  await metadata.load();

  const manager = new SyncManager(
    vault,
    fileManager,
    github,
    metadata,
    effective,
    host.debugLog,
  );

  return { manager, metadata, effective, armVault };
}

async function persistRunResult(
  host: BindingHost,
  binding: VaultBinding,
  summary: SyncSummary | null,
  message: string,
): Promise<void> {
  const stored = host.getSettings().bindings.find((candidate) => candidate.id === binding.id);
  if (stored) {
    stored.lastSyncSummary = message;
    stored.lastSyncCompletedAt = summary ? Date.now() : stored.lastSyncCompletedAt;
    await host.persistBinding(stored);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncBinding(
  host: BindingHost,
  binding: VaultBinding,
  options: {
    confirmPlan?: (summary: SyncSummary) => Promise<boolean>;
    onProgress?: (progress: SyncProgress) => void;
  } = {},
): Promise<BindingRunResult> {
  const label = binding.name || binding.repo;
  const pendingConflicts = host.getBindingConflicts(binding.id);
  if (pendingConflicts && pendingConflicts.length > 0) {
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: false,
      kind: "skipped",
      summary: null,
      conflicts: pendingConflicts,
      message: "Skipped: unresolved conflicts from an earlier sync.",
    };
  }

  let runner: BindingRunner;
  try {
    runner = await createBindingRunner(host, binding);
  } catch (error) {
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: false,
      kind: "failed",
      summary: null,
      conflicts: [],
      message: describeError(error),
    };
  }

  try {
    const summary = options.confirmPlan
      ? await runner.manager.syncWithConfirmation(options.confirmPlan, {
          onProgress: options.onProgress,
        })
      : await runner.manager.sync({ onProgress: options.onProgress });

    const message = summary ? `Synced: ${summarizeCounts(summary)}` : "Cancelled.";
    await persistRunResult(host, binding, summary, message);
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: true,
      kind: summary ? "synced" : "skipped",
      summary,
      conflicts: [],
      message,
    };
  } catch (error) {
    if (error instanceof SyncConflictError) {
      host.setBindingConflicts(binding.id, error.conflicts);
      const message = `Stopped: ${error.conflicts.length} conflict(s).`;
      await persistRunResult(host, binding, null, message);
      return {
        bindingId: binding.id,
        bindingName: label,
        ok: false,
        kind: "conflict",
        summary: null,
        conflicts: error.conflicts,
        message,
      };
    }

    const message = `Failed: ${describeError(error)}`;
    await persistRunResult(host, binding, null, message);
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: false,
      kind: "failed",
      summary: null,
      conflicts: [],
      message,
    };
  }
}

export async function simulateBinding(host: BindingHost, binding: VaultBinding): Promise<BindingRunResult> {
  const label = binding.name || binding.repo;

  try {
    const runner = await createBindingRunner(host, binding);
    const summary = await runner.manager.planSync();
    const message = `Simulation: ${summarizeCounts(summary)}`;
    await persistRunResult(host, binding, null, message);
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: true,
      kind: "simulated",
      summary,
      conflicts: summary.conflicts,
      message,
    };
  } catch (error) {
    const message = `Simulation failed: ${describeError(error)}`;
    await persistRunResult(host, binding, null, message);
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: false,
      kind: "failed",
      summary: null,
      conflicts: [],
      message,
    };
  }
}

export async function resolveBindingConflicts(
  host: BindingHost,
  binding: VaultBinding,
  paths: string[],
  resolution: ConflictResolution,
): Promise<BindingRunResult> {
  const label = binding.name || binding.repo;

  try {
    const runner = await createBindingRunner(host, binding);
    const summary = await runner.manager.resolveConflicts(paths, resolution);
    host.setBindingConflicts(binding.id, null);
    const message = `Resolved: ${summarizeCounts(summary)}`;
    await persistRunResult(host, binding, summary, message);
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: true,
      kind: "synced",
      summary,
      conflicts: [],
      message,
    };
  } catch (error) {
    const message = `Conflict resolution failed: ${describeError(error)}`;
    await persistRunResult(host, binding, null, message);
    return {
      bindingId: binding.id,
      bindingName: label,
      ok: false,
      kind: "failed",
      summary: null,
      conflicts: [],
      message,
    };
  }
}

/**
 * Syncs every enabled binding in sequence. In hub mode that includes all arm
 * vaults; in standalone mode the caller passes only the self binding.
 */
export async function syncAllBindings(
  host: BindingHost,
  options: { bindings: VaultBinding[]; confirmUnappliedPlans?: boolean } ,
): Promise<BindingRunResult[]> {
  const results: BindingRunResult[] = [];
  const enabled = options.bindings.filter((binding) => binding.enabled);
  let index = 0;

  for (const binding of enabled) {
    index += 1;
    const label = binding.name || binding.repo;
    new Notice(`Otto: syncing arm ${index}/${enabled.length} (${label})...`, 0);

    const result = await syncBinding(host, binding);
    results.push(result);

    if (result.kind === "synced") {
      new Notice(`Otto: ${label} — ${result.message}`);
    } else {
      new Notice(`Otto: ${label} — ${result.message}`, 8000);
    }
  }

  new Notice(`Otto: finished syncing ${results.length} arm(s).`, 4000);
  return results;
}

function summarizeCounts(summary: SyncSummary): string {
  const parts: string[] = [];
  if (summary.uploaded) parts.push(`${summary.uploaded} uploaded`);
  if (summary.downloaded) parts.push(`${summary.downloaded} downloaded`);
  if (summary.deletedLocal) parts.push(`${summary.deletedLocal} local deletions`);
  if (summary.deletedRemote) parts.push(`${summary.deletedRemote} remote deletions`);
  if (summary.foldersUploaded) parts.push(`${summary.foldersUploaded} folders uploaded`);
  if (summary.foldersDownloaded) parts.push(`${summary.foldersDownloaded} folders downloaded`);
  if (summary.foldersDeletedLocal) parts.push(`${summary.foldersDeletedLocal} local folder deletions`);
  if (summary.foldersDeletedRemote) parts.push(`${summary.foldersDeletedRemote} remote folder deletions`);
  if (summary.conflicts.length) parts.push(`${summary.conflicts.length} conflicts`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}
