import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TFolder, setRequestUrlMock } from "obsidian";
import { GitHubClient } from "../src/github";
import { createAuthProvider } from "../src/auth";
import { MetadataStore } from "../src/metadata";
import { NodeFsFileManager, NodeFsVault } from "../src/node-vault";
import { SyncManager, hasUserVisibleSyncChanges } from "../src/sync";
import { DEFAULT_SETTINGS, type OctosyncSettings } from "../src/types";
import { createHash } from "node:crypto";

// node-vault.ts loads builtins through globalThis.require with a CJS fallback;
// vitest executes tests as ESM, so install the loader up front.
(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url);

const settings: OctosyncSettings = {
  ...DEFAULT_SETTINGS,
  token: "token",
  owner: "octo",
  repo: "vault",
  branch: "main",
};

let tempDirs: string[] = [];

async function makeTempVault(files: Record<string, string>, dirs: string[] = []): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "otto-vault-"));
  tempDirs.push(dir);

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  for (const dirName of dirs) {
    await fs.mkdir(path.join(dir, dirName), { recursive: true });
  }
  return dir;
}

afterEach(async () => {
  setRequestUrlMock(null);
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("NodeFsVault", () => {
  it("walks the vault into TFile/TFolder structures", async () => {
    const dir = await makeTempVault({
      "notes/a.md": "alpha",
      "notes/deep/b.md": "beta",
      "root.md": "root",
    }, ["empty"]);

    const vault = new NodeFsVault(dir);
    await vault.rescan();

    const filePaths = vault.getFiles().map((file) => file.path).sort();
    expect(filePaths).toEqual(["notes/a.md", "notes/deep/b.md", "root.md"]);

    const notes = vault.getAbstractFileByPath("notes");
    expect(notes).toBeInstanceOf(TFolder);
    expect((notes as TFolder).children.map((child) => child.path).sort()).toEqual([
      "notes/a.md",
      "notes/deep",
    ]);

    expect(vault.getAbstractFileByPath("notes/deep")).toBeInstanceOf(TFolder);
    expect(vault.getAbstractFileByPath("missing.md")).toBeNull();
    expect(vault.configDir).toBe(".obsidian");
  });

  it("reads, creates, and modifies binary content", async () => {
    const dir = await makeTempVault({ "a.md": "alpha" });
    const vault = new NodeFsVault(dir);
    await vault.rescan();

    const file = vault.getAbstractFileByPath("a.md");
    expect(new TextDecoder().decode(await vault.readBinary(file as never))).toBe("alpha");

    await vault.createBinary("new/deep/c.md", new TextEncoder().encode("created").buffer);
    expect(await fs.readFile(path.join(dir, "new", "deep", "c.md"), "utf8")).toBe("created");
    expect(vault.getAbstractFileByPath("new/deep/c.md")).not.toBeNull();

    const created = vault.getAbstractFileByPath("new/deep/c.md");
    await vault.modifyBinary(created as never, new TextEncoder().encode("modified").buffer);
    expect(await fs.readFile(path.join(dir, "new", "deep", "c.md"), "utf8")).toBe("modified");
  });

  it("exposes adapter operations", async () => {
    const dir = await makeTempVault({ "a.md": "alpha" }, ["folder"]);
    const vault = new NodeFsVault(dir);
    await vault.rescan();

    expect(await vault.adapter.exists("a.md")).toBe(true);
    expect(await vault.adapter.exists("missing.md")).toBe(false);

    const stat = await vault.adapter.stat("a.md");
    expect(stat?.type).toBe("file");

    const folderStat = await vault.adapter.stat("folder");
    expect(folderStat?.type).toBe("folder");

    const listing = await vault.adapter.list(".");
    expect(listing.files).toContain("a.md");
    expect(listing.folders).toContain("folder");

    expect(await vault.adapter.read("a.md")).toBe("alpha");
    await vault.adapter.write("b.md", "bravo");
    expect(await fs.readFile(path.join(dir, "b.md"), "utf8")).toBe("bravo");

    await vault.adapter.mkdir("made/deeper");
    expect(await vault.adapter.exists("made/deeper")).toBe(true);

    await vault.adapter.remove("b.md");
    expect(await vault.adapter.exists("b.md")).toBe(false);
  });

  it("trashes files and folders into .trash", async () => {
    const dir = await makeTempVault({ "a.md": "alpha", "sub/b.md": "beta" });
    const vault = new NodeFsVault(dir);
    await vault.rescan();

    await vault.trash(vault.getAbstractFileByPath("a.md") as never);
    expect(await fs.access(path.join(dir, "a.md")).then(() => true).catch(() => false)).toBe(false);
    const trashDir = path.join(dir, ".trash");
    expect((await fs.readdir(trashDir)).length).toBe(1);

    await vault.trash(vault.getAbstractFileByPath("sub") as never);
    expect(await fs.access(path.join(dir, "sub")).then(() => true).catch(() => false)).toBe(false);
    expect(vault.getAbstractFileByPath("a.md")).toBeNull();
    expect(vault.getAbstractFileByPath("sub")).toBeNull();
  });

  it("refuses to escape the vault root", async () => {
    const dir = await makeTempVault({ "a.md": "alpha" });
    const vault = new NodeFsVault(dir);

    expect(() => vault.resolveSafe("../outside.md")).toThrow();
    expect(() => vault.resolveSafe("a.md")).not.toThrow();
    await expect(vault.adapter.exists("../outside.md")).rejects.toThrow();
  });

  it("treats a folder containing only ignored children as present but empty for the engine", async () => {
    const dir = await makeTempVault({}, [".obsidian"]);
    const vault = new NodeFsVault(dir);
    await vault.rescan();

    // No files are returned; the .obsidian folder exists in the tree so the
    // engine's ignore logic decides emptiness exactly as with a real vault.
    expect(vault.getFiles().length).toBe(0);
    const obsidian = vault.getAbstractFileByPath(".obsidian");
    expect(obsidian).toBeInstanceOf(TFolder);
  });
});

/**
 * Minimal in-memory GitHub Git Data API used to exercise the full engine
 * against a filesystem vault without the network. Blob SHAs are real git blob
 * SHA-1 digests so the engine's local/remote comparisons behave realistically.
 */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

class FakeGithubRepo {
  private blobs = new Map<string, Buffer>();
  private trees = new Map<string, Map<string, string>>();
  private commits = new Map<string, string>();
  private refs = new Map<string, string>();
  private counter = 0;

  constructor() {
    this.trees.set(EMPTY_TREE_SHA, new Map());
    this.refs.set("main", this.commitFromTree(EMPTY_TREE_SHA));
  }

  private commitFromTree(treeSha: string): string {
    this.counter += 1;
    const sha = `commit-${this.counter}`;
    this.commits.set(sha, treeSha);
    return sha;
  }

  private putBlob(bytes: Buffer): string {
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    this.blobs.set(sha, bytes);
    return sha;
  }

  private currentTree(): Map<string, string> {
    const commitSha = this.refs.get("main") ?? "";
    const treeSha = this.commits.get(commitSha) ?? "";
    const tree = this.trees.get(treeSha);
    if (!tree) {
      throw new Error("Fake repo has no tree for the current ref.");
    }
    return tree;
  }

  commitFiles(files: Record<string, string>): void {
    const tree = new Map(this.currentTree());
    for (const [filePath, content] of Object.entries(files)) {
      tree.set(filePath, this.putBlob(Buffer.from(content, "utf8")));
    }
    this.counter += 1;
    const treeSha = `tree-${this.counter}`;
    this.trees.set(treeSha, tree);
    this.refs.set("main", this.commitFromTree(treeSha));
  }

  treePaths(): string[] {
    return Array.from(this.currentTree().keys()).sort();
  }

  async handler(request: {
    url: string;
    method?: string;
    body?: string;
  }): Promise<{ status: number; text: string; json: unknown; headers: Record<string, string> }> {
    const url = new URL(request.url);
    const method = request.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean);
    const rest = segments[0] === "repos" ? segments.slice(3) : segments;
    const respond = (status: number, body: unknown) => ({
      status,
      text: JSON.stringify(body),
      json: body,
      headers: {},
    });

    if (method === "GET" && rest[0] === "git" && rest[1] === "ref") {
      const branch = rest.slice(3).join("/");
      const sha = this.refs.get(branch);
      return sha
        ? respond(200, { object: { sha } })
        : respond(404, { message: "Not Found" });
    }

    if (method === "PATCH" && rest[0] === "git" && rest[1] === "refs") {
      const branch = rest.slice(3).join("/");
      const body = JSON.parse(request.body ?? "{}") as { sha: string };
      if (!this.commits.has(body.sha)) {
        return respond(422, { message: "Object does not exist" });
      }
      this.refs.set(branch, body.sha);
      return respond(200, {});
    }

    if (method === "POST" && rest[0] === "git" && rest[1] === "blobs") {
      const body = JSON.parse(request.body ?? "{}") as { content: string };
      return respond(201, { sha: this.putBlob(Buffer.from(body.content, "base64")) });
    }

    if (method === "POST" && rest[0] === "git" && rest[1] === "trees") {
      const body = JSON.parse(request.body ?? "{}") as {
        base_tree?: string;
        tree: Array<{ path: string; sha: string | null }>;
      };
      const base = body.base_tree ? this.trees.get(body.base_tree) : undefined;
      const tree = new Map(base ?? this.currentTree());
      for (const entry of body.tree) {
        if (entry.sha === null) {
          tree.delete(entry.path);
        } else {
          tree.set(entry.path, entry.sha);
        }
      }
      this.counter += 1;
      const treeSha = `tree-${this.counter}`;
      this.trees.set(treeSha, tree);
      return respond(201, { sha: treeSha });
    }

    if (method === "POST" && rest[0] === "git" && rest[1] === "commits") {
      const body = JSON.parse(request.body ?? "{}") as { tree: string };
      return respond(201, { sha: this.commitFromTree(body.tree) });
    }

    if (method === "GET" && rest[0] === "git" && rest[1] === "commits") {
      const sha = rest[2];
      const treeSha = this.commits.get(sha);
      return treeSha
        ? respond(200, { sha, tree: { sha: treeSha } })
        : respond(404, { message: "Not Found" });
    }

    if (method === "GET" && rest[0] === "git" && rest[1] === "trees") {
      const treeSha = rest[2];
      const tree = this.trees.get(treeSha);
      if (!tree) {
        return respond(404, { message: "Not Found" });
      }
      const entries = Array.from(tree.entries()).map(([entryPath, blobSha]) => ({
        path: entryPath,
        mode: "100644",
        type: "blob",
        sha: blobSha,
        size: this.blobs.get(blobSha)?.length ?? 0,
      }));
      return respond(200, { sha: treeSha, tree: entries, truncated: false });
    }

    if (method === "GET" && rest[0] === "git" && rest[1] === "blobs") {
      const sha = rest[2];
      const bytes = this.blobs.get(sha);
      return bytes
        ? respond(200, { sha, content: bytes.toString("base64"), encoding: "base64" })
        : respond(404, { message: "Not Found" });
    }

    if (method === "GET" && rest[0] === "branches") {
      return respond(
        200,
        Array.from(this.refs.entries()).map(([name, sha]) => ({ name, commit: { sha } })),
      );
    }

    if (method === "GET" && rest.length === 0) {
      return respond(200, {
        name: "vault",
        full_name: "octo/vault",
        owner: { login: "octo" },
        default_branch: "main",
        private: true,
      });
    }

    return respond(404, { message: `Unhandled fake request: ${method} ${url.pathname}` });
  }
}

async function makeManager(vault: NodeFsVault, repo: FakeGithubRepo): Promise<SyncManager> {
  setRequestUrlMock((request) => repo.handler(request));

  let storedMetadata: unknown;
  const metadata = new MetadataStore(
    async () => storedMetadata,
    async (data) => {
      storedMetadata = data;
    },
  );
  await metadata.load();

  return new SyncManager(
    vault as never,
    new NodeFsFileManager(vault) as never,
    new GitHubClient(createAuthProvider(settings)),
    metadata,
    settings,
  );
}

describe("engine over a filesystem vault", () => {
  it("uploads a local vault, then reaches a no-op steady state", async () => {
    const dir = await makeTempVault(
      { "notes/a.md": "alpha", "notes/b.md": "beta", "root.md": "root" },
      ["empty"],
    );
    const vault = new NodeFsVault(dir);
    await vault.rescan();
    const repo = new FakeGithubRepo();
    const manager = await makeManager(vault, repo);

    const summary = await manager.sync();
    expect(summary.uploaded).toBe(3);
    expect(summary.foldersUploaded).toBe(1);
    expect(summary.conflicts).toEqual([]);
    expect(repo.treePaths()).toEqual([
      "empty/.octosync-folder",
      "notes/a.md",
      "notes/b.md",
      "root.md",
    ]);

    const second = await manager.sync();
    expect(hasUserVisibleSyncChanges(second)).toBe(false);
    expect(second.uploaded).toBe(0);
    expect(second.downloaded).toBe(0);
    expect(second.deletedRemote).toBe(0);
  });

  it("downloads remote-only changes into the filesystem vault", async () => {
    const dir = await makeTempVault({ "notes/a.md": "alpha" });
    const vault = new NodeFsVault(dir);
    await vault.rescan();
    const repo = new FakeGithubRepo();
    const manager = await makeManager(vault, repo);

    await manager.sync();

    repo.commitFiles({ "notes/c.md": "gamma" });
    const summary = await manager.sync();
    expect(summary.downloaded).toBe(1);
    expect(await fs.readFile(path.join(dir, "notes", "c.md"), "utf8")).toBe("gamma");
  });

  it("deletes remote files when they are deleted locally", async () => {
    const dir = await makeTempVault({ "notes/a.md": "alpha", "notes/b.md": "beta" });
    const vault = new NodeFsVault(dir);
    await vault.rescan();
    const repo = new FakeGithubRepo();
    const manager = await makeManager(vault, repo);

    await manager.sync();

    await fs.rm(path.join(dir, "notes", "a.md"));
    await vault.rescan();
    const summary = await manager.sync();
    expect(summary.deletedRemote).toBe(1);
    expect(repo.treePaths()).not.toContain("notes/a.md");
    expect(repo.treePaths()).toContain("notes/b.md");
  });

  it("keeps uploads and downloads consistent across repeated rescans", async () => {
    const dir = await makeTempVault({ "a.md": "one" });
    const vault = new NodeFsVault(dir);
    await vault.rescan();
    const repo = new FakeGithubRepo();
    const manager = await makeManager(vault, repo);

    await manager.sync();
    await fs.writeFile(path.join(dir, "a.md"), "two", "utf8");
    await vault.rescan();

    const summary = await manager.sync();
    expect(summary.uploaded).toBe(1);
    expect(repo.currentTree().get("a.md")).toBe(
      createHash("sha1").update("blob 3\0").update(Buffer.from("two", "utf8")).digest("hex"),
    );
  });
});
