import type { OctosyncSettings, VaultBinding } from "./types";

/**
 * Sentinel vault path for the binding that describes the vault the plugin
 * itself runs in (the hub's own vault, or the standalone vault on mobile).
 */
export const SELF_VAULT_PATH = "";

export function generateBindingId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `arm-${crypto.randomUUID()}`;
  }
  return `arm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBinding(init: Partial<VaultBinding> = {}): VaultBinding {
  return {
    id: init.id ?? generateBindingId(),
    name: init.name ?? "",
    vaultPath: init.vaultPath ?? SELF_VAULT_PATH,
    owner: init.owner ?? "",
    repo: init.repo ?? "",
    branch: init.branch ?? "",
    token: init.token ?? "",
    enabled: init.enabled ?? true,
    syncBookmarks: init.syncBookmarks ?? false,
    excludePaths: [...(init.excludePaths ?? [])],
    lastSyncSummary: init.lastSyncSummary ?? "",
    lastSyncCompletedAt: init.lastSyncCompletedAt ?? null,
  };
}

/**
 * Normalizes an absolute vault folder path typed by the user. Returns null when
 * the path is empty, relative, a drive/UNC root, or otherwise unusable.
 */
export function normalizeVaultFolderPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/"/g, "");
  if (!trimmed || trimmed.includes("\0")) {
    return null;
  }

  // Detect UNC roots on the raw string, before separators are unified
  // ("\\server\share" and "//server/share" both become "/server/share").
  const rawSegments = trimmed.split(/[\\/]+/).filter(Boolean);
  const isUncRaw = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
  if (isUncRaw && rawSegments.length < 2) {
    return null;
  }

  const unified = trimmed.replace(/[\\/]+/g, "/");
  const withoutTail = unified.replace(/\/+$/, "");
  if (!withoutTail) {
    return null;
  }

  // Reject relative paths and drive roots ("C:").
  const isDrivePath = /^[a-zA-Z]:/.test(withoutTail);
  if (!withoutTail.includes("/")) {
    return null;
  }
  if (isDrivePath && withoutTail.split("/").filter(Boolean).length < 2) {
    return null;
  }
  if (!isDrivePath && !isUncRaw && !withoutTail.startsWith("/")) {
    return null;
  }

  return withoutTail;
}

export function bindingLabel(binding: VaultBinding, hubVaultPath: string | null): string {
  if (binding.vaultPath === SELF_VAULT_PATH) {
    return `${binding.name} (this vault)`;
  }

  if (hubVaultPath && sameVaultPath(binding.vaultPath, hubVaultPath)) {
    return `${binding.name} (this vault)`;
  }

  return binding.name;
}

function sameVaultPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export interface ValidateBindingOptions {
  /** Absolute path of the vault running the plugin, when known (desktop). */
  hubVaultPath?: string | null;
  /** When true the vault path must be a real absolute folder path (arm bindings). */
  requireVaultPath?: boolean;
}

/** Returns a list of human-readable problems; empty means the binding is valid. */
export function validateBinding(
  candidate: VaultBinding,
  allBindings: VaultBinding[],
  options: ValidateBindingOptions = {},
): string[] {
  const problems: string[] = [];

  if (!candidate.name.trim()) {
    problems.push("A display name is required.");
  }

  if (options.requireVaultPath && candidate.vaultPath === SELF_VAULT_PATH) {
    problems.push(
      "Arm bindings need an absolute vault folder path. Leave the path empty only for the plugin's own vault.",
    );
  }

  for (const field of [
    ["owner", candidate.owner],
    ["repository", candidate.repo],
    ["branch", candidate.branch],
  ] as const) {
    if (!field[1].trim()) {
      problems.push(`Missing GitHub ${field[0]}.`);
    }
  }

  const others = allBindings.filter((binding) => binding.id !== candidate.id);
  const target = `${candidate.owner}/${candidate.repo}/${candidate.branch}`.toLowerCase();
  if (candidate.owner && candidate.repo && candidate.branch) {
    const duplicateRepo = others.find(
      (binding) =>
        `${binding.owner}/${binding.repo}/${binding.branch}`.toLowerCase() === target,
    );
    if (duplicateRepo) {
      problems.push(`Another arm ("${duplicateRepo.name}") already syncs ${candidate.owner}/${candidate.repo} on ${candidate.branch}.`);
    }
  }

  if (candidate.vaultPath !== SELF_VAULT_PATH) {
    const normalizedVault = normalizeVaultFolderPath(candidate.vaultPath);
    if (!normalizedVault) {
      problems.push("Enter an absolute folder path for the vault (e.g. C:\\Notes\\Vault or /Users/me/Vault).");
    } else {
      const duplicateVault = others.find(
        (binding) =>
          binding.vaultPath !== SELF_VAULT_PATH &&
          sameVaultPath(binding.vaultPath, candidate.vaultPath),
      );
      if (duplicateVault) {
        problems.push(`Another arm ("${duplicateVault.name}") already points at this vault folder.`);
      }

      if (options.hubVaultPath && sameVaultPath(candidate.vaultPath, options.hubVaultPath)) {
        problems.push("This is the hub's own vault. Leave the path empty to bind it directly.");
      }
    }
  }

  return problems;
}

export function getSelfBinding(bindings: VaultBinding[]): VaultBinding | undefined {
  return bindings.find((binding) => binding.vaultPath === SELF_VAULT_PATH);
}

/**
 * Makes sure a self binding exists and mirrors the legacy single-vault settings
 * (owner/repo/branch/token/syncBookmarks) into it, so the existing settings UI
 * remains the source of truth for the plugin's own vault.
 */
export function ensureSelfBinding(settings: OctosyncSettings): VaultBinding {
  let self = getSelfBinding(settings.bindings);

  if (!self) {
    self = createBinding({ name: settings.branch ? "This vault" : "This vault", vaultPath: SELF_VAULT_PATH });
    settings.bindings.push(self);
  }

  self.owner = settings.owner;
  self.repo = settings.repo;
  self.branch = settings.branch;
  self.token = "";
  self.syncBookmarks = settings.syncBookmarks;
  self.excludePaths = [...settings.syncVaultExcludePaths];
  self.enabled = Boolean(settings.owner && settings.repo && settings.branch);
  return self;
}

/**
 * One-time migration from legacy Octosync data: when no bindings exist but a
 * repository is configured, create the self binding from it. Returns true when
 * settings changed and should be persisted.
 */
export function migrateLegacyToBindings(settings: OctosyncSettings): boolean {
  if (settings.bindings.length > 0) {
    return false;
  }

  if (!settings.owner || !settings.repo || !settings.branch) {
    ensureSelfBinding(settings);
    return true;
  }

  settings.bindings.push(
    createBinding({
      name: "This vault",
      vaultPath: SELF_VAULT_PATH,
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch,
      token: "",
      enabled: true,
      syncBookmarks: settings.syncBookmarks,
      excludePaths: [...settings.syncVaultExcludePaths],
    }),
  );
  return true;
}

export function findBinding(bindings: VaultBinding[], id: string): VaultBinding | undefined {
  return bindings.find((binding) => binding.id === id);
}
