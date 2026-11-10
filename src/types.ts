export type AuthMode = "pat";
export type SyncMode = "manual" | "automatic";
/**
 * Otto Octavius Sync manager mode.
 * - "standalone": the plugin syncs only the vault it runs in (works on mobile).
 * - "hub": desktop only. The plugin vault is the hub and syncs every enabled
 *   vault binding (arm), including vault folders without the plugin installed.
 */
export type ManagerMode = "standalone" | "hub";

/**
 * One vault-to-repository binding (an "arm"). A binding whose vaultPath is the
 * sentinel SELF_VAULT_PATH describes the vault the plugin itself runs in.
 */
export interface VaultBinding {
  id: string;
  name: string;
  /** Absolute path of the vault folder on this machine. Empty string = the plugin's own vault. */
  vaultPath: string;
  owner: string;
  repo: string;
  branch: string;
  /** Optional per-binding token override; falls back to the global token. */
  token: string;
  enabled: boolean;
  syncBookmarks: boolean;
  /** Vault-relative paths excluded from sync for this binding only. */
  excludePaths: string[];
  lastSyncSummary: string;
  lastSyncCompletedAt: number | null;
}

export interface OctosyncSettings {
  authMode: AuthMode;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  syncMode: SyncMode;
  confirmBeforeManualSync: boolean;
  localChangeIndicatorEnabled: boolean;
  localChangePeriodicFullScan: boolean;
  remoteChangeIndicatorEnabled: boolean;
  remoteChangeCheckIntervalMinutes: number;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  syncCommunityPlugins: boolean;
  syncThemes: boolean;
  syncSnippets: boolean;
  syncBookmarks: boolean;
  syncVaultExcludePaths: string[];
  syncExcludePaths: string[];
  syncExtraHiddenDirs: string[];
  debugLogging: boolean;
  managerMode: ManagerMode;
  bindings: VaultBinding[];
  lastSyncStartedAt: number | null;
  lastSyncCompletedAt: number | null;
  lastSyncSummary: string;
}

export interface SyncFileRecord {
  path: string;
  sha: string | null;
  dirty: boolean;
  lastModified: number;
  deleted: boolean;
}

export interface SyncFolderRecord {
  path: string;
  markerSha: string | null;
  lastModified: number;
  deleted: boolean;
}

export interface SyncMetadata {
  version: 1;
  files: Record<string, SyncFileRecord>;
  folders: Record<string, SyncFolderRecord>;
}

export interface GitHubRepository {
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  default_branch: string;
  private: boolean;
  permissions?: {
    push?: boolean;
  };
}

export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
  };
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitHubTree {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

export interface GitHubBlob {
  sha: string;
  content: string;
  encoding: "base64" | "utf-8";
}

export interface RemoteFile {
  path: string;
  sha: string;
  size: number;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  foldersUploaded: number;
  foldersDownloaded: number;
  foldersDeletedLocal: number;
  foldersDeletedRemote: number;
  excluded: number;
  conflicts: string[];
}

export const DEFAULT_SETTINGS: OctosyncSettings = {
  authMode: "pat",
  token: "",
  owner: "",
  repo: "",
  branch: "",
  syncMode: "manual",
  confirmBeforeManualSync: true,
  localChangeIndicatorEnabled: true,
  localChangePeriodicFullScan: true,
  remoteChangeIndicatorEnabled: false,
  remoteChangeCheckIntervalMinutes: 15,
  syncOnStartup: false,
  syncIntervalMinutes: 0,
  syncCommunityPlugins: false,
  syncThemes: false,
  syncSnippets: false,
  syncBookmarks: false,
  syncVaultExcludePaths: [],
  syncExcludePaths: [],
  syncExtraHiddenDirs: [],
  debugLogging: false,
  managerMode: "standalone",
  bindings: [],
  lastSyncStartedAt: null,
  lastSyncCompletedAt: null,
  lastSyncSummary: "",
};
