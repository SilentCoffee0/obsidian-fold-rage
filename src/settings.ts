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

/** Narrowing guard, so no type assertion is needed to read unknown data. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function asDelay(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000
		? Math.round(value)
		: fallback;
}

/**
 * Build settings from whatever `Plugin.loadData()` returns.
 *
 * `loadData()` is typed as `any`, so assigning its result straight into a typed
 * field is an unsafe assignment. Validating each field keeps the types honest,
 * and means a hand-edited or corrupted data.json degrades to defaults rather
 * than putting a bad value into the repair path.
 */
export function normalizeSettings(raw: unknown): FoldRageSettings {
	if (!isRecord(raw)) return { ...DEFAULT_SETTINGS };
	return {
		autoRepair: asBoolean(raw.autoRepair, DEFAULT_SETTINGS.autoRepair),
		repairDelayMs: asDelay(raw.repairDelayMs, DEFAULT_SETTINGS.repairDelayMs),
		showNotifications: asBoolean(raw.showNotifications, DEFAULT_SETTINGS.showNotifications),
		showSessionCounter: asBoolean(raw.showSessionCounter, DEFAULT_SETTINGS.showSessionCounter),
		enableTestApi: asBoolean(raw.enableTestApi, DEFAULT_SETTINGS.enableTestApi),
	};
}

export const DEFAULT_SETTINGS: FoldRageSettings = {
	autoRepair: true,
	repairDelayMs: 150,
	showNotifications: false,
	showSessionCounter: false,
	enableTestApi: false,
};

/**
 * Settings are declared imperatively in `display()` on purpose.
 *
 * Obsidian's automated review suggests `getSettingDefinitions()`, which powers
 * settings search. That API requires Obsidian 1.13.0 or later, while Fold Rage
 * declares `minAppVersion` 1.5.8 — a floor established by actually running the
 * verification suite against 1.5.8, 1.12.4 and 1.13.7. Adopting it would either
 * drop every user below 1.13.0 or mean maintaining two parallel settings
 * implementations for four toggles, so the imperative form stays until the
 * supported floor moves past 1.13.0.
 */
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
