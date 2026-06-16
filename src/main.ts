import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { MemoView, MEMO_VIEW_TYPE } from './MemoView';

interface PluginSettings {
	autoOpen: boolean;
	pinTab:   boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	autoOpen: true,
	pinTab:   false,
};

export default class MemomoPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();

		this.registerView(MEMO_VIEW_TYPE, (leaf) => new MemoView(leaf, this));

		this.addRibbonIcon('pencil', 'MeMemo', () => this.activateView());

		this.addCommand({
			id: 'open-mememo',
			name: 'Open MeMemo',
			callback: () => this.activateView(),
		});

		this.addSettingTab(new MeMemoSettingTab(this.app, this));

		let layoutReady = false;

		this.app.workspace.onLayoutReady(() => {
			layoutReady = true;
			if (this.settings.autoOpen) this.activateView();
		});

		// Reopen automatically if pinTab is on and the tab gets closed
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			if (!layoutReady) return;
			if (this.settings.pinTab && this.app.workspace.getLeavesOfType(MEMO_VIEW_TYPE).length === 0) {
				this.activateView();
			}
		}));
	}

	async activateView() {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(MEMO_VIEW_TYPE);
		if (existing.length) {
			workspace.setActiveLeaf(existing[0], { focus: true });
			return;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: MEMO_VIEW_TYPE, active: true });
		if (this.settings.pinTab) leaf.setPinned(true);
		workspace.setActiveLeaf(leaf, { focus: true });
	}

	async onunload() {
		this.app.workspace.detachLeavesOfType(MEMO_VIEW_TYPE);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MeMemoSettingTab extends PluginSettingTab {
	plugin: MemomoPlugin;

	constructor(app: App, plugin: MemomoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'MeMemo Settings' });

		new Setting(containerEl)
			.setName('Open on startup')
			.setDesc('Automatically open MeMemo tab when Obsidian starts.')
			.addToggle(t => t
				.setValue(this.plugin.settings.autoOpen)
				.onChange(async (v) => {
					this.plugin.settings.autoOpen = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Pin tab')
			.setDesc('Pin the MeMemo tab so it persists across sessions and reopens automatically.')
			.addToggle(t => t
				.setValue(this.plugin.settings.pinTab)
				.onChange(async (v) => {
					this.plugin.settings.pinTab = v;
					await this.plugin.saveSettings();
					// Apply immediately to any open leaf
					const leaves = this.app.workspace.getLeavesOfType(MEMO_VIEW_TYPE);
					if (leaves.length) leaves[0].setPinned(v);
				}));
	}
}
