# Otto Octavius Sync — design

Otto Octavius Sync is a fork-branch of [Octosync](https://github.com/grumpydev/octosync) that extends a proven single-vault GitHub sync engine into a multi-vault manager: **one vault → one repo, as many pairs as you need**.

The name is the architecture: Doctor Octopus is one brain with many arms. One Obsidian vault hosts the plugin (the **hub**); every registered vault→repository pair is an **arm** (a *binding* in code).

## Goals and non-goals

Goals:

1. Add as many vault↔repo bindings as required, managed from a single control panel.
2. Reuse the upstream sync engine unchanged — its plan-then-apply semantics, conflict detection, empty-folder markers, and metadata model are the reason Octosync is safe, and 119 upstream unit tests keep guarding them.
3. Zero impact on the upstream single-vault experience; existing Octosync settings migrate automatically.
4. Mobile stays fully functional (standalone mode).

Non-goals (deliberate):

- No cross-vault *moving* or merging of notes; arms are independent sync scopes.
- No daemon/scheduler outside Obsidian; hub syncs run while the hub vault is open.
- No writing into arm vaults' `.obsidian` config (except what the sync plan itself writes when the user opts into config sync for that arm).

## How Obsidian constrains the design

A plugin instance is vault-scoped: `app.vault` only exposes the vault it runs in, and plugin enablement cannot be controlled from another vault. Two consequences:

- **Arm vaults need no plugin.** On desktop, Obsidian ships Node.js (Electron). A plugin may use `node:fs` to reach any folder on disk, so the hub reads arm vaults directly from the filesystem. Arms never need Obsidian running.
- **Mobile cannot reach other vaults.** iOS/Android sandbox Obsidian. Otto therefore has two manager modes: `hub` (desktop-only) and `standalone` (the upstream behavior, everywhere). If `managerMode === "hub"` is loaded on mobile it is normalized to `standalone` at startup.

## Core concepts

### VaultBinding (src/types.ts)

One arm = one record:

```ts
interface VaultBinding {
  id: string;            // stable id, keys metadata and conflict slots
  name: string;          // display name
  vaultPath: string;     // absolute folder path; "" = the vault running the plugin
  owner: string; repo: string; branch: string;
  token: string;         // optional per-binding token override
  enabled: boolean;
  syncBookmarks: boolean;
  excludePaths: string[];// device-local exclusions for this arm only
  lastSyncSummary: string;
  lastSyncCompletedAt: number | null;
}
```

Bindings live in `settings.bindings`. The legacy single-repo fields (`settings.owner/repo/branch/token`) remain the source of truth for the **self binding** (vaultPath `""`), so the entire existing settings tab and its behaviors keep working; `ensureSelfBinding` mirrors them into the binding list on every save. `migrateLegacyToBindings` creates the self binding from a pre-fork Octosync install on first load, so upgrading users see no behavior change until they add arms.

### Engine reuse via a filesystem shim (src/node-vault.ts)

`SyncManager` (upstream, untouched) programs against a narrow slice of Obsidian's API: `getFiles`, `getAllLoadedFiles`, `getAbstractFileByPath`, `readBinary`, `createBinary`, `modifyBinary`, `createFolder`, `adapter.{exists,stat,list,read,readBinary,write,writeBinary,mkdir,remove}`, `configDir`, plus `FileManager.trashFile`. `NodeFsVault` implements exactly that slice on top of `node:fs`:

- `TFile`/`TFolder` instances are built with `Object.create(TFile.prototype)` so the engine's `instanceof` checks behave identically in the app and under the vitest obsidian mock.
- Vault-relative paths are posix-normalized; the root folder is `"/"` like Obsidian; every disk access passes through `resolveSafe`, which rejects absolute inputs, NUL bytes, and `..` escapes outside the vault root.
- `getFiles()` lists everything on disk; path filtering stays in the engine's `shouldIgnorePath` (config dir, hidden dirs, reserved files), matching how the engine re-adds allowed config paths through the adapter.
- Deletes go to the arm vault's `.trash/` (engine-excluded), never straight to `unlink`.
- `rescan()` rebuilds the tree before each sync run; between runs the cache is kept consistent by the mutating operations themselves.

Mobile safety is structural: `node:fs`/`node:path` are loaded through a lazy `require` helper (`globalThis.require` with a CJS fallback), the module body has no top-level Node calls, and `binding-sync.ts` reaches it only through `await import("./node-vault")` behind a `Platform.isDesktopApp` guard. The production bundle was inspected: `require("fs")` exists only inside the lazy loader, and esbuild wraps the module body in its lazy-init stub.

### Per-binding sync runs (src/binding-sync.ts)

`BindingHost` is the capability interface the plugin implements (vault, file manager, settings, per-binding metadata slots, arm vault opener, debug log). For each run:

1. `buildEffectiveSettings` merges the binding into a snapshot: `owner/repo/branch` from the binding, token = binding override or global, per-binding exclusions/bookmarks, and `syncCommunityPlugins` forced off for arms (community plugin installation writes into the plugin vault only).
2. A dedicated `MetadataStore` instance is wired to a `bindingMetadata[bindingId]` slot in the hub's `data.json` — arm tracking never touches the arm vault, and the self binding keeps the legacy top-level `metadata` slot.
3. `SyncManager` is constructed with the self vault (`app.vault`/`app.fileManager`) or a freshly rescanned `NodeFsVault`, then run via the upstream `sync()` / `syncWithConfirmation()` / `planSync()` / `resolveConflicts()` paths.

Arms sync **sequentially** (`syncAllBindings`) — never concurrently, so the engine's non-fast-forward commit retry logic stays sound per repository. Conflicts are stored per binding (`getBindingConflicts`/`setBindingConflicts`; the self binding shares the upstream `pendingConflictPaths` flow) and surfaced in the vault manager instead of blocking the whole hub.

### UI (src/vault-manager.ts, settings-tab)

`VaultManagerModal` lists every binding with repo/branch, last result, conflict badges, and actions: Sync all arms, Sync, Simulate, Edit, Remove, and per-arm conflict review (the upstream `ConflictResolutionModal` gained an optional `resolver` callback so the same dialog works for any binding). `BindingEditModal` validates with `validateBinding` (duplicate repo targets, duplicate vault folders, relative paths, hub self-registration). The settings tab adds a manager-mode dropdown and a "Vault registry" summary with a button into the manager.

### What the hub interval does

`configureIntervalSync` and the automatic-startup path dispatch to `syncAllVaults()` (all enabled bindings) in hub mode and to the upstream self-sync otherwise. The ribbon opens the vault manager in hub mode and syncs the vault in standalone mode.

## Data layout

```
<hub-vault>/.obsidian/plugins/otto-octavius-sync/data.json
{
  "settings": { ..., "managerMode": "hub", "bindings": [ ... ] },
  "metadata":      { SyncMetadata },              // self binding (legacy slot)
  "bindingMetadata": { "<bindingId>": { SyncMetadata } },
  "debugLog": [...]
}
```

Tokens stay in settings (redacted in the debug log by upstream code). Nothing is written into arm vaults other than note files, empty-folder markers, and `.trash/` moves.

## Failure model

- A failed arm sync fails alone: results are per-binding (`BindingRunResult`), the hub continues with the next arm, and metadata rollback per arm is upstream's `metadataSnapshot`/`restore` behavior, now isolated per binding.
- Repointing a binding at another repo/branch behaves like upstream's repo change: stale SHAs re-plan from scratch — run Simulate first (the manager exposes it per arm).
- Removing a binding deletes its metadata slot and conflict state; the arm vault's files are untouched.
- Hub and a standalone install on the *same* vault would keep separate metadata stores; the docs tell users to pick one mode per vault per machine.

## Testing

- `tests/vault-registry.test.ts` — migration, self-binding mirroring, validation (duplicate repos, duplicate folders, relative paths, hub self-registration).
- `tests/binding-sync.test.ts` — effective settings merging (token fallback, arm restrictions, no global mutation).
- `tests/node-vault.test.ts` — real temp-dir vaults: tree walking, binary IO, adapter surface, trash, path-escape refusal, plus **engine integration**: `SyncManager` runs end-to-end against `NodeFsVault` and an in-memory GitHub Git Data API (blobs/trees/commits/refs with real git blob SHA-1s) covering first upload, no-op steady state, remote-only download, local-delete → remote-delete, and re-upload after external edits.
- Upstream suites (119 tests) run unmodified and keep guarding the engine, GitHub client, metadata, and settings logic.
