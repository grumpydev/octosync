import { Modal, Notice, Setting } from "obsidian";
import type OctosyncPlugin from "./main";
import { ConflictResolutionModal } from "./conflict-modal";
import {
  resolveBindingConflicts,
  simulateBinding,
  syncBinding,
  syncAllBindings,
} from "./binding-sync";
import {
  createBinding,
  normalizeVaultFolderPath,
  validateBinding,
} from "./vault-registry";
import type { VaultBinding } from "./types";

/**
 * The Otto Octavius vault manager: the hub's control panel listing every
 * registered vault arm with its repository, sync controls, and conflict review.
 */
export class VaultManagerModal extends Modal {
  private busy = false;

  constructor(private readonly plugin: OctosyncPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { settings } = this.plugin;
    this.contentEl.empty();

    this.titleEl.setText("Otto Octavius — vault manager");

    const status = this.contentEl.createDiv({ cls: "octosync-manager-status" });
    const enabledCount = settings.bindings.filter((binding) => binding.enabled).length;
    status.createSpan({
      text: this.plugin.isHubMode()
        ? `Hub mode on desktop. ${settings.bindings.length} vault(s) registered, ${enabledCount} enabled.`
        : "Standalone mode: only this vault is synced. Hub mode requires the desktop app.",
    });

    if (this.plugin.isHubMode() && enabledCount > 1) {
      new Setting(this.contentEl)
        .setName("Sync all arms")
        .setDesc("Runs a full sync for every enabled vault in sequence, each against its own repository.")
        .addButton((button) => {
          button
            .setButtonText(this.busy ? "Syncing..." : "Sync all")
            .setCta()
            .setDisabled(this.busy)
            .onClick(async () => {
              await this.withBusy(async () => {
                await this.plugin.syncAllVaults();
              });
              this.render();
            });
        });
    }

    const list = this.contentEl.createDiv({ cls: "octosync-manager-list" });

    for (const binding of settings.bindings) {
      list.appendChild(this.renderBindingRow(binding));
    }

    new Setting(this.contentEl)
      .setName("Register another vault")
      .setDesc("Point one vault folder at one repository. Add as many arms as you need.")
      .addButton((button) => {
        button.setButtonText("Add vault").onClick(() => {
          new BindingEditModal(this.plugin, null, () => this.render()).open();
        });
      });
  }

  private renderBindingRow(binding: VaultBinding): HTMLElement {
    const row = this.contentEl.createDiv({ cls: "octosync-binding-row" });
    const conflicts = this.plugin.getBindingConflicts(binding.id);

    const header = row.createDiv({ cls: "octosync-binding-header" });
    const title = header.createDiv({ cls: "octosync-binding-title" });
    title.createSpan({ text: binding.name || binding.repo, cls: "octosync-binding-name" });
    title.createSpan({
      text: binding.vaultPath === "" ? "this vault" : binding.vaultPath,
      cls: "octosync-binding-vault",
    });
    if (!binding.enabled) {
      title.createSpan({ text: "disabled", cls: "octosync-binding-badge is-disabled" });
    }
    if (conflicts && conflicts.length > 0) {
      title.createSpan({ text: `${conflicts.length} conflict(s)`, cls: "octosync-binding-badge is-conflict" });
    }

    row.createDiv({
      cls: "octosync-binding-meta",
      text: `${binding.owner}/${binding.repo} @ ${binding.branch}`,
    });

    if (binding.lastSyncSummary) {
      row.createDiv({ cls: "octosync-binding-summary", text: binding.lastSyncSummary });
    }

    const actions = row.createDiv({ cls: "octosync-binding-actions" });

    if (conflicts && conflicts.length > 0) {
      this.addButton(actions, "Review conflicts", "mod-warning", async () => {
        new ConflictResolutionModal(this.plugin, conflicts, () => this.render(), async (paths, resolution) => {
          const result = await resolveBindingConflicts(
            this.plugin.bindingHost(),
            binding,
            paths,
            resolution,
          );
          new Notice(`Otto: ${binding.name || binding.repo} — ${result.message}`);
          this.render();
        }).open();
      });
    }

    this.addButton(actions, "Sync", "mod-cta", async () => {
      await this.withBusy(async () => {
        const result = await syncBinding(this.plugin.bindingHost(), binding);
        new Notice(`Otto: ${binding.name || binding.repo} — ${result.message}`, 8000);
      });
      this.render();
    });

    this.addButton(actions, "Simulate", undefined, async () => {
      await this.withBusy(async () => {
        const result = await simulateBinding(this.plugin.bindingHost(), binding);
        new Notice(`Otto: ${binding.name || binding.repo} — ${result.message}`, 10000);
      });
      this.render();
    });

    this.addButton(actions, "Edit", undefined, () => {
      new BindingEditModal(this.plugin, binding, () => this.render()).open();
    });

    this.addButton(actions, "Remove", undefined, async () => {
      await this.plugin.removeBinding(binding.id);
      this.render();
    });

    return row;
  }

  private addButton(
    container: HTMLElement,
    text: string,
    cls: string | undefined,
    onClick: () => Promise<void> | void,
  ): void {
    const button = container.createEl("button", { text });
    if (cls) {
      button.addClass(cls);
    }
    button.addEventListener("click", () => {
      void onClick();
    });
  }

  private async withBusy(operation: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await operation();
    } finally {
      this.busy = false;
    }
  }
}

/** Form for creating or editing a vault arm binding. */
class BindingEditModal extends Modal {
  private draft: VaultBinding;

  constructor(
    private readonly plugin: OctosyncPlugin,
    private readonly existing: VaultBinding | null,
    private readonly onSaved: () => void,
  ) {
    super(plugin.app);
    this.draft = existing
      ? { ...existing, excludePaths: [...existing.excludePaths] }
      : createBinding({ name: "" });
  }

  onOpen(): void {
    this.titleEl.setText(this.existing ? "Edit vault arm" : "Add vault arm");
    this.render();
  }

  private render(): void {
    this.contentEl.empty();

    const isSelfEdit = this.draft.vaultPath === "";

    new Setting(this.contentEl)
      .setName("Display name")
      .addText((text) => {
        text.setValue(this.draft.name).onChange((value) => {
          this.draft.name = value;
        });
      });

    new Setting(this.contentEl)
      .setName("Vault folder")
      .setDesc(
        isSelfEdit
          ? "This arm is the vault running the plugin."
          : "Absolute path of the vault folder on this machine (desktop only). Leave empty to bind the plugin's own vault.",
      )
      .addText((text) => {
        text
          .setPlaceholder("C:\\Notes\\MyVault or /Users/me/Vaults/MyVault")
          .setValue(this.draft.vaultPath)
          .onChange((value) => {
            this.draft.vaultPath = value.trim() === "" ? "" : value.trim();
          });
      });

    new Setting(this.contentEl).setName("Repository").setHeading();

    new Setting(this.contentEl)
      .setName("Owner")
      .addText((text) => text.setValue(this.draft.owner).onChange((value) => (this.draft.owner = value.trim())));

    new Setting(this.contentEl)
      .setName("Repository")
      .addText((text) => text.setValue(this.draft.repo).onChange((value) => (this.draft.repo = value.trim())));

    new Setting(this.contentEl)
      .setName("Branch")
      .addText((text) => text.setValue(this.draft.branch).onChange((value) => (this.draft.branch = value.trim())));

    new Setting(this.contentEl)
      .setName("Token override (optional)")
      .setDesc("A fine-grained token for this repository. Falls back to the global token when empty.")
      .addText((text) => {
        text.setValue(this.draft.token).onChange((value) => (this.draft.token = value.trim()));
        text.inputEl.type = "password";
      });

    new Setting(this.contentEl)
      .setName("Sync bookmarks")
      .setDesc("Include this vault's bookmarks.json in sync.")
      .addToggle((toggle) => {
        toggle.setValue(this.draft.syncBookmarks).onChange(async (value) => {
          this.draft.syncBookmarks = value;
        });
      });

    new Setting(this.contentEl)
      .setName("Enabled")
      .addToggle((toggle) => {
        toggle.setValue(this.draft.enabled).onChange(async (value) => {
          this.draft.enabled = value;
        });
      });

    new Setting(this.contentEl)
      .setName("Excluded vault paths")
      .setDesc("One vault-relative folder path per line. Never synced for this arm on this machine.")
      .addTextArea((textArea) => {
        textArea
          .setPlaceholder("Personal\nArchive/Private")
          .setValue(this.draft.excludePaths.join("\n"));
        textArea.inputEl.rows = 3;
        textArea.inputEl.addEventListener("change", () => {
          this.draft.excludePaths = textArea
            .getValue()
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        });
      });

    const actions = this.contentEl.createDiv({ cls: "octosync-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    const saveButton = actions.createEl("button", {
      text: this.existing ? "Save" : "Add vault",
      cls: "mod-cta",
    });
    saveButton.addEventListener("click", async () => {
      // The plugin's own vault binding is edited with an empty path; new arms
      // must supply an absolute folder path.
      const isSelfEdit = this.existing !== null && this.existing.vaultPath === "";
      const problems = validateBinding(this.draft, this.plugin.settings.bindings, {
        requireVaultPath: !isSelfEdit,
        hubVaultPath: this.plugin.getHubVaultPath(),
      });
      if (problems.length > 0) {
        new Notice(problems.join(" "), 8000);
        return;
      }
      await this.plugin.saveBindingDraft(this.draft);
      this.close();
      this.onSaved();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function normalizeDraftVaultPath(path: string): string | null {
  return normalizeVaultFolderPath(path);
}
