import { App, PluginSettingTab, Setting } from 'obsidian';
import type FoldRagePlugin from './main';

export interface FoldRageSettings {
	/** Repair over-reaching fold ranges automatically. */
	autoRepair: boolean;
	/** Delay before checking a newly mounted or restored editor, in ms. */
	repairDelayMs: number;
	/** Notify only when an automatic repair actually changed something. */
	showNotifications: boolean;
	/** Show a repair count inside this settings page. Nothing is stored or sent. */
	showSessionCounter: boolean;
	/**
	 * Undocumented, and deliberately absent from this settings page: enables the
	 * API used by the repository's automated verification. The disposable test
	 * vault sets it; a normal install never does.
	 */
	enableTestApi: boolean;
}

export const DEFAULT_SETTINGS: FoldRageSettings = {
	autoRepair: true,
	repairDelayMs: 150,
	showNotifications: false,
	showSessionCounter: false,
	enableTestApi: false,
};

export class FoldRageSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FoldRagePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Automatic repair')
			.setDesc('Automatically repair over-reaching fold ranges in Live Preview.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoRepair).onChange(async (v) => {
					this.plugin.settings.autoRepair = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Repair delay')
			.setDesc(
				'How long to wait before checking a newly opened or restored editor, in milliseconds. ' +
					'The delay lets Live Preview finish restoring its folds first.',
			)
			.addSlider((s) =>
				s
					.setLimits(0, 1000, 50)
					.setValue(this.plugin.settings.repairDelayMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.repairDelayMs = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show repair notifications')
			.setDesc('Show a brief notice when an automatic repair actually changes something. Off means completely silent.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showNotifications).onChange(async (v) => {
					this.plugin.settings.showNotifications = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Show session repair count')
			.setDesc('Show how many folds were repaired since Obsidian started. Shown here only; nothing is stored or sent anywhere.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showSessionCounter).onChange(async (v) => {
					this.plugin.settings.showSessionCounter = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.showSessionCounter) {
			const { repairs, folds } = this.plugin.sessionStats();
			new Setting(containerEl)
				.setName('Folds repaired this session')
				.setDesc(`${folds} fold${folds === 1 ? '' : 's'} across ${repairs} repair${repairs === 1 ? '' : 's'}. Resets when Obsidian restarts.`);
		}
	}
}
