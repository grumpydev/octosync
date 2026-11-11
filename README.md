# Otto Octavius Sync

<p align="center">
  <img src="logo.png" alt="Otto Octavius Sync logo" width="128" height="128">
</p>

Otto Octavius Sync is an Obsidian plugin that syncs vaults directly with GitHub without requiring a local Git install — and unlike its upstream project [Octosync](https://github.com/grumpydev/octosync), it can manage **many vaults at once**, each pointed at its own repository.

Like its eight-armed namesake, one vault acts as the hub (the brain) and reaches every registered vault (an arm) on the same machine. Phones, tablets, locked-down work laptops, and lightweight machines can all be awkward places to install, authenticate, and maintain Git. Otto talks to GitHub's API from inside Obsidian, so a device only needs Obsidian, the plugin, and GitHub tokens with access to the repositories you choose.

## Multiple Vaults, Multiple Repositories

**Every vault-to-repository pair is a "binding" (an arm).** Add as many as you need from the vault manager:

- **Hub mode** (desktop): the vault running the plugin manages every arm. Arm vaults do **not** need the plugin installed or enabled — Otto reads and writes their folders directly on disk and syncs each one to its own `owner/repo/branch` through the same plan-then-apply engine used for the hub vault itself.
- **Standalone mode** (default, works everywhere incl. mobile): the plugin syncs only the vault it runs in, exactly like upstream Octosync. On mobile, hub mode is unavailable and Otto falls back to standalone automatically.
- Each binding has its own branch, optional token override, bookmark sync preference, and device-local exclusions. The plugin's own vault is always a binding too, so a fresh install behaves like Octosync (single vault → single repo) until you register more arms.

Open the manager with the ribbon icon in hub mode, the command palette ("Open vault manager"), or the **Vault registry** section of the settings. From there you can sync all arms, sync or simulate one arm, review per-arm conflicts, and add/edit/remove bindings.

Arm sync metadata (per-file SHAs) is stored in the hub vault's plugin data, keyed by binding — nothing is written into the arm vaults' `.obsidian` folders. The engine deliberately excludes `.obsidian/**` (and reserved paths like `.git/`, `.trash/`, `.gitignore`) from every vault, so tokens and device-specific state are never uploaded.

Install from the [Obsidian Community Plugin directory](https://community.obsidian.md/plugins/octosync).

## Why Use It

- Sync an Obsidian vault to a normal GitHub repository.
- Use GitHub-backed sync on phones and non-dev machines without local Git.
- Preview changes with simulation before applying them.
- Keep selected vault folders off specific devices without deleting their GitHub copies.
- Choose manual sync for full control or automatic sync for routine updates.
- Keep `.obsidian/**` out of sync by default, avoiding token and device-specific settings leaks.
- Detect conflicts and stop for a user decision instead of silently overwriting notes.

Octosync is deliberately conservative. It plans the sync before applying it, tracks file metadata, treats deletes carefully, and avoids partial local changes if a remote write fails.

## Sync Modes

Octosync supports two main workflows.

**Manual sync** runs only when you click the ribbon icon, use the command palette, or start sync from settings. Manual mode can also require confirmation: Octosync prepares the sync plan, shows what it intends to upload, download, or delete, and waits for approval before changing anything.

**Automatic sync** can run on startup, on an interval, or both. It uses the same planning engine as manual sync, but applies safe plans without asking each time.

The settings screen also includes **Simulate sync**. Simulation builds the same plan as a real sync and reports what would happen without changing local files, GitHub files, or Octosync metadata. It is useful before first sync, after changing repositories or branches, and any time the vault state feels uncertain.

## Change Indicators

The toolbar icon can show when Octosync sees pending local changes. This is a local-only check: it uses Obsidian file events, incremental checks, and optionally a periodic local scan. It does not contact GitHub and does not detect remote-only changes.

Manual mode can separately check GitHub for remote changes on an interval. That check is read-only and only updates the visual indicator so you know a manual sync may be needed.

## Settings

![Octosync settings screen](docs/octosync-settings.png)

**Sync community plugins** syncs `community-plugins.json` (the enabled-plugin ID list) and, after each sync, downloads and installs any enabled plugin that is missing locally. Plugin code (`manifest.json`, `main.js`, `styles.css`) is fetched from the plugin's own GitHub release, resolved via the official Obsidian community plugin registry — the same source Obsidian's built-in installer uses. Plugin data folders (settings, API keys/tokens) are never synced or downloaded.

**Sync bookmarks** optionally syncs `bookmarks.json` in the vault's configured Obsidian configuration directory. It is off by default, including on upgrades. Workspace layouts, plugin settings, and tokens remain excluded. Enable it on each device that should share bookmarks, using the same configuration-directory path.

Bookmarks sync as a whole file, not a merged list. Different versions on the first sync, or edits on both sides since the last sync, use the normal conflict-resolution flow. Run **Simulate sync** before first syncing bookmarks. Turning the option off leaves both copies in place and forgets their tracking; re-enabling compares them as a fresh sync. Device-local exclusions and hidden-path exclusions still take precedence. Check the Bookmarks pane after receiving changes; restart Obsidian if it has not refreshed before editing bookmarks again.

## Device-Local Exclusions

**Excluded vault paths** accepts one vault-relative folder path per line, such as `Personal` or `Archive/Private`. The setting belongs to the current device. Matching folders and their contents are omitted from uploads, downloads, deletions, conflicts, empty-folder handling, and change indicators on that device, while their GitHub copies and other devices remain untouched.

When an exclusion is enabled, Octosync forgets this device's old sync metadata for matching paths. That prevents a later local deletion from being interpreted as a GitHub deletion and ensures that removing the exclusion downloads the remote copy again. Existing local files are deliberately not deleted automatically.

For a folder that is already present locally:

1. Add the folder to **Excluded vault paths**.
2. Run **Simulate sync** and confirm it reports the paths as device-local exclusions with no remote deletions.
3. Remove the local folder manually.
4. Run simulation once more before syncing.

Device-local exclusions are a sync boundary, not an access-control boundary. Octosync still enumerates the repository tree, and the configured GitHub token can access the whole repository. Use separate vaults or repositories when a device must not have technical access to the excluded content.

## Safety Net

Sync tools need a high bar because mistakes can damage a vault. Octosync includes unit tests for the sync engine and GitHub client, plus an Obsidian end-to-end suite that launches a disposable vault against a temporary GitHub branch.

The automated tests cover settings UI behavior, simulation, local and remote change indicators, uploads, downloads, local deletes, remote deletes, device-local exclusions, empty folders, conflict detection, conflict resolution modes, and protection against partial changes when a sync stops on conflict.

That testing does not remove the need for backups, especially while the plugin is young, but it gives the sync logic a real safety net rather than relying only on happy-path manual testing.

## Privacy And Access

Octosync enumerates vault files so it can compare local paths with the configured GitHub branch and decide what needs to sync. It deliberately excludes `.obsidian/**` so plugin settings, tokens, and device-specific Obsidian state are not uploaded as notes.

Octosync does not read from or write to the system clipboard.

## Support

Octosync is free to use. If it saves you time and you want to support ongoing development, you can sponsor the project on [GitHub Sponsors](https://github.com/sponsors/grumpydev) or send a one-off tip on [Ko-fi](https://ko-fi.com/grumpydev).

Support is optional and does not unlock features.

## Manual Installation

Build or download the plugin files, then place them in:

```text
<vault>/.obsidian/plugins/otto-octavius-sync/
```

The folder should contain:

```text
main.js
manifest.json
styles.css
```

Restart Obsidian or reload plugins, then enable Otto Octavius Sync from Community plugins.

## GitHub Token

Otto uses a fine-grained GitHub personal access token. Create one for only the repository you want to sync and grant:

- `Contents`: read and write
- `Metadata`: read

Store the global token in Otto's settings inside Obsidian, or set a per-binding token override in the vault manager for arms that live in other repositories or accounts. Otto excludes `.obsidian/**` from vault sync so plugin settings and tokens are not uploaded as notes.

When a hub syncs arm vaults on desktop, it needs tokens with access to *all* of their repositories (one broad token, or per-binding tokens).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, sync safety expectations, and release notes.

Install dependencies:

```bash
npm install
```

Run unit tests:

```bash
npm test
```

Build the plugin:

```bash
npm run build
```

Run the development watcher:

```bash
npm run dev
```

Build and install into a local vault:

```bash
npm run local-install -- "/path/to/Your Vault"
```

Regenerate the settings screenshot:

```bash
npm run screenshot:settings
```

The screenshot helper uses a disposable vault under `tmp/screenshots/` and refuses to run while Obsidian is already open.

## End-to-End Tests

The E2E suite launches Obsidian with a disposable vault under `tmp/e2e/`, installs the built Octosync plugin into that vault, and syncs against a temporary `octosync-e2e-*` branch in a throwaway GitHub repository.

Create the local E2E environment file:

```bash
cp env.e2e.sample .env.e2e
```

Fill in:

```text
OCTOSYNC_E2E_GITHUB_TOKEN=
OCTOSYNC_E2E_OWNER=
OCTOSYNC_E2E_REPO=
```

Use a repository dedicated to testing. The token should have read/write contents access to that repository.

Run the suite:

```bash
npm run test:e2e
```

By default, the harness cleans up the temporary vault and GitHub branch. Set `OCTOSYNC_E2E_KEEP_ARTIFACTS=true` to keep them for inspection.

On macOS, the harness refuses to start if another Obsidian process is already running because Electron can reuse an existing app instance. The harness verifies that Obsidian opened the disposable vault before it enables or exercises Octosync. If your Obsidian build shows the "Trust author and enable plugins" prompt, confirm it once after checking the visible vault path matches the path printed by the harness.

Useful debugging flags:

```text
OCTOSYNC_E2E_INSPECT_ON_FAILURE=true
OCTOSYNC_E2E_VERBOSE=true
OCTOSYNC_E2E_ALLOW_EXISTING_OBSIDIAN=true
```

Only use `OCTOSYNC_E2E_ALLOW_EXISTING_OBSIDIAN=true` when deliberately debugging startup behavior.

## License

MIT
