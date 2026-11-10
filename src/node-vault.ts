import { TFile, TFolder } from "obsidian";

/**
 * Desktop-only filesystem adapter that lets the shared SyncManager engine sync
 * vault folders that do NOT have Obsidian open. It implements exactly the slice
 * of the Obsidian Vault/FileManager API surface that SyncManager uses, backed by
 * node:fs.
 *
 * Mobile safety: node builtins are loaded lazily via require() inside functions,
 * and the module itself is only loaded through a dynamic import guarded by
 * Platform.isDesktopApp, so this code never evaluates on mobile.
 *
 * Engine compatibility notes:
 * - TFile/TFolder objects are created with Object.create(TFile.prototype) so the
 *   engine's `instanceof` checks behave exactly as they do with real vault files.
 * - getFiles() returns every file on disk; path filtering (config dir, hidden
 *   dirs, exclusions) stays in the engine's shouldIgnorePath, matching how the
 *   engine re-adds allowed config paths through the adapter.
 */

type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");

/**
 * Resolves node builtins lazily. Works in the Obsidian desktop CJS bundle and
 * under vitest's ESM runner (tests install globalThis.require); never called on
 * mobile because this module is only loaded behind a desktop guard.
 */
function nodeRequire(id: string): unknown {
  const globalRequire = (globalThis as { require?: (moduleId: string) => unknown }).require;
  if (globalRequire) {
    return globalRequire(id);
  }
  if (typeof require !== "undefined") {
    return require(id);
  }
  throw new Error(`Node module "${id}" is unavailable in this environment.`);
}

function loadFs(): FsModule {
  return nodeRequire("fs") as FsModule;
}

function loadPath(): PathModule {
  return nodeRequire("path") as PathModule;
}

export interface NodeVaultStat {
  type: "file" | "folder";
  size: number;
  ctime: number;
  mtime: number;
}

export class NodeFsVault {
  readonly configDir = ".obsidian";
  readonly adapter: NodeFsAdapter;

  private readonly root: string;
  private files = new Map<string, TFile>();
  private folders = new Map<string, TFolder>();
  private rootFolder!: TFolder;

  constructor(rootPath: string) {
    const path = loadPath();
    this.root = path.resolve(rootPath);
    this.adapter = new NodeFsAdapter(this);
  }

  /** True when the desktop Node integration is available. */
  static isAvailable(): boolean {
    try {
      loadFs();
      loadPath();
      return true;
    } catch {
      return false;
    }
  }

  get rootPath(): string {
    return this.root;
  }

  /** Rebuilds the in-memory tree from disk. Call before constructing a SyncManager. */
  async rescan(): Promise<void> {
    const fs = loadFs();
    const path = loadPath();
    this.files = new Map();
    this.folders = new Map();

    this.rootFolder = this.createFolderNode("/");
    this.folders.set("/", this.rootFolder);

    const walk = async (absDir: string, relDir: string, parent: TFolder): Promise<void> => {
      const entries = await fs.promises.readdir(absDir, { withFileTypes: true });

      for (const entry of entries) {
        const absEntry = path.join(absDir, entry.name);
        // Obsidian vault paths never carry a leading slash: root children are
        // "note.md" and "notes/a.md", while the root folder itself is "/".
        const relEntry = relDir === "/" ? entry.name : `${relDir}/${entry.name}`;

        if (entry.isSymbolicLink()) {
          continue;
        }

        if (entry.isDirectory()) {
          const folder = this.createFolderNode(relEntry, parent);
          this.folders.set(relEntry, folder);
          parent.children.push(folder);
          await walk(absEntry, relEntry, folder);
          continue;
        }

        if (entry.isFile()) {
          const file = this.createFileNode(relEntry, parent);
          this.files.set(relEntry, file);
          parent.children.push(file);
        }
      }
    };

    await walk(this.root, "/", this.rootFolder);
  }

  getFiles(): TFile[] {
    return Array.from(this.files.values());
  }

  getAllLoadedFiles(): TFolder[] {
    return Array.from(this.folders.values());
  }

  getAbstractFileByPath(vaultPath: string): TFile | TFolder | null {
    const normalized = normalizeVaultPath(vaultPath);
    if (!normalized) {
      return null;
    }
    return this.files.get(normalized) ?? this.folders.get(normalized) ?? null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const fs = loadFs();
    const buffer = await fs.promises.readFile(this.resolveSafe(file.path));
    return toArrayBuffer(buffer);
  }

  async createBinary(vaultPath: string, bytes: ArrayBuffer): Promise<TFile> {
    const fs = loadFs();
    const abs = this.resolveSafe(vaultPath);
    await fs.promises.mkdir(loadPath().dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(bytes));

    const normalized = normalizeVaultPath(vaultPath) ?? "/";
    let existing = this.files.get(normalized);
    if (!existing) {
      await this.registerNewPath(normalized);
      existing = this.files.get(normalized);
    }
    return existing as TFile;
  }

  async modifyBinary(file: TFile, bytes: ArrayBuffer): Promise<void> {
    const fs = loadFs();
    await fs.promises.writeFile(this.resolveSafe(file.path), Buffer.from(bytes));
  }

  async createFolder(vaultPath: string): Promise<TFolder> {
    const fs = loadFs();
    const abs = this.resolveSafe(vaultPath);
    await fs.promises.mkdir(abs, { recursive: true });

    const normalized = normalizeVaultPath(vaultPath) ?? "/";
    let existing = this.folders.get(normalized);
    if (!existing) {
      await this.registerNewPath(normalized);
      existing = this.folders.get(normalized);
    }
    return existing as TFolder;
  }

  /** Moves a file or folder into the vault's .trash directory (excluded from sync). */
  async trash(node: TFile | TFolder): Promise<void> {
    const fs = loadFs();
    const path = loadPath();
    const normalized = normalizeVaultPath(node.path);
    if (!normalized || normalized === "/") {
      return;
    }

    const trashDir = path.join(this.root, ".trash");
    await fs.promises.mkdir(trashDir, { recursive: true });
    const name = normalized.split("/").pop() ?? "item";
    const target = path.join(trashDir, `${Date.now()}-${name}`);
    await fs.promises.rename(this.resolveSafe(normalized), target);

    this.unregisterPath(normalized);
  }

  /** Absolute path of a vault-relative path, refusing escapes outside the vault. */
  resolveSafe(vaultPath: string): string {
    const path = loadPath();
    if (path.isAbsolute(vaultPath) || vaultPath.includes("\0")) {
      throw new Error(`Refusing to access path outside the vault: ${vaultPath}`);
    }

    const abs = path.resolve(this.root, vaultPath);
    const rel = path.relative(this.root, abs);
    // rel === "" means the vault root itself, which is a legitimate target
    // (adapter.list("") enumerates the root, mirroring Obsidian's adapter).
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Refusing to access path outside the vault: ${vaultPath}`);
    }
    return abs;
  }

  async statNode(vaultPath: string): Promise<NodeVaultStat | null> {
    const fs = loadFs();
    try {
      const stats = await fs.promises.stat(this.resolveSafe(vaultPath));
      return {
        type: stats.isDirectory() ? "folder" : "file",
        size: stats.size,
        ctime: stats.ctimeMs,
        mtime: stats.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async listNode(vaultPath: string): Promise<{ files: string[]; folders: string[] }> {
    const fs = loadFs();
    const abs = this.resolveSafe(vaultPath);
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    const files: string[] = [];
    const folders: string[] = [];

    for (const entry of entries) {
      const rel = joinVaultPath(vaultPath, entry.name);
      if (entry.isDirectory()) {
        folders.push(rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }

    return { files, folders };
  }

  async existsNode(vaultPath: string): Promise<boolean> {
    return (await this.statNode(vaultPath)) !== null;
  }

  async readNode(vaultPath: string): Promise<string> {
    const fs = loadFs();
    return fs.promises.readFile(this.resolveSafe(vaultPath), "utf8");
  }

  async writeNode(vaultPath: string, data: string): Promise<void> {
    const fs = loadFs();
    const abs = this.resolveSafe(vaultPath);
    await fs.promises.mkdir(loadPath().dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, data, "utf8");
  }

  async writeBinaryNode(vaultPath: string, bytes: ArrayBuffer): Promise<void> {
    const fs = loadFs();
    const abs = this.resolveSafe(vaultPath);
    await fs.promises.mkdir(loadPath().dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(bytes));
  }

  async mkdirNode(vaultPath: string): Promise<void> {
    const fs = loadFs();
    await fs.promises.mkdir(this.resolveSafe(vaultPath), { recursive: true });
  }

  async removeNode(vaultPath: string): Promise<void> {
    const fs = loadFs();
    const abs = this.resolveSafe(vaultPath);
    const stats = await fs.promises.stat(abs);
    if (stats.isDirectory()) {
      await fs.promises.rm(abs, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(abs);
    }

    const normalized = normalizeVaultPath(vaultPath);
    if (normalized) {
      this.unregisterPath(normalized);
    }
  }

  private async registerNewPath(normalized: string): Promise<void> {
    const stat = await this.statNode(normalized);
    if (!stat) {
      return;
    }

    const parentPath = parentVaultPath(normalized) ?? "/";
    const parent = this.folders.get(parentPath) ?? this.rootFolder;
    if (stat.type === "folder") {
      const folder = this.createFolderNode(normalized, parent);
      this.folders.set(normalized, folder);
      parent.children.push(folder);
      // Register any children that already exist (e.g. mkdir of a populated dir).
      const entries = await this.listNode(normalized);
      for (const child of [...entries.folders, ...entries.files]) {
        await this.registerNewPath(child);
      }
    } else {
      const file = this.createFileNode(normalized, parent);
      this.files.set(normalized, file);
      parent.children.push(file);
    }
  }

  private unregisterPath(normalized: string): void {
    const file = this.files.get(normalized);
    const folder = this.folders.get(normalized);
    const node = file ?? folder;
    if (node && node.parent) {
      node.parent.children = node.parent.children.filter((child) => child !== node);
    }
    this.files.delete(normalized);
    this.folders.delete(normalized);

    if (folder) {
      for (const key of Array.from(this.folders.keys())) {
        if (key.startsWith(`${normalized}/`)) {
          for (const nestedFile of this.filesBetween(key)) {
            this.files.delete(nestedFile);
          }
          this.folders.delete(key);
        }
      }
    }
  }

  private filesBetween(folderPath: string): string[] {
    const prefix = `${folderPath}/`;
    return Array.from(this.files.keys()).filter((filePath) => filePath.startsWith(prefix));
  }

  private createFileNode(vaultPath: string, parent: TFolder): TFile {
    const file = Object.create(TFile.prototype) as TFile;
    const name = vaultPath.split("/").pop() ?? "";
    const dotIndex = name.lastIndexOf(".");
    const extension = dotIndex > 0 ? name.slice(dotIndex + 1) : "";
    Object.assign(file, {
      vault: null,
      path: vaultPath,
      name,
      basename: dotIndex > 0 ? name.slice(0, dotIndex) : name,
      extension,
      stat: { ctime: 0, mtime: 0, size: 0 },
      parent,
    });
    return file;
  }

  private createFolderNode(vaultPath: string, parent?: TFolder): TFolder {
    const folder = Object.create(TFolder.prototype) as TFolder;
    Object.assign(folder, {
      vault: null,
      path: vaultPath,
      name: vaultPath === "/" ? "" : vaultPath.split("/").pop() ?? "",
      parent: parent ?? null,
      children: [],
      isRoot: vaultPath === "/",
    });
    return folder;
  }
}

/** FileManager shim exposing the single method the engine uses. */
export class NodeFsFileManager {
  constructor(private readonly vault: NodeFsVault) {}

  async trashFile(node: TFile | TFolder): Promise<void> {
    await this.vault.trash(node);
  }
}

/**
 * DataAdapter subset used by the engine, the plugin installer, and config-file
 * sync (bookmarks, community-plugins.json, themes, snippets).
 */
export class NodeFsAdapter {
  constructor(private readonly vault: NodeFsVault) {}

  async exists(path: string): Promise<boolean> {
    return this.vault.existsNode(path);
  }

  async stat(path: string): Promise<NodeVaultStat | null> {
    return this.vault.statNode(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.vault.listNode(path);
  }

  async read(path: string): Promise<string> {
    return this.vault.readNode(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const fs = loadFs();
    const buffer = await fs.promises.readFile(this.vault.resolveSafe(path));
    return toArrayBuffer(buffer);
  }

  async write(path: string, data: string): Promise<void> {
    await this.vault.writeNode(path, data);
  }

  async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    await this.vault.writeBinaryNode(path, bytes);
  }

  async mkdir(path: string): Promise<void> {
    await this.vault.mkdirNode(path);
  }

  async remove(path: string): Promise<void> {
    await this.vault.removeNode(path);
  }
}

function normalizeVaultPath(vaultPath: string): string | null {
  const normalized = vaultPath.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return normalized === "" || normalized === "/" ? null : normalized;
}

function joinVaultPath(base: string, name: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  if (!normalizedBase || normalizedBase === "/" || normalizedBase === ".") {
    return name;
  }
  return `${normalizedBase}/${name}`;
}

function parentVaultPath(vaultPath: string): string | null {
  const slashIndex = vaultPath.lastIndexOf("/");
  return slashIndex <= 0 ? null : vaultPath.slice(0, slashIndex);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes.buffer;
}
