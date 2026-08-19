import { MarkdownView, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, FoldRageSettingTab, type FoldRageSettings } from './settings';
import { EditorRegistry, registryExtension, setActiveRegistry, type EditorEntry } from './registry';
import { FoldAutoRepair } from './autorepair';

/**
 * Replaced with the literal `false` by esbuild in released builds, so the test
 * API and its helpers are removed by dead-code elimination and never ship.
 */
declare const INCLUDE_TEST_API: boolean;

/**
 * Fold Rage — stay in your range.
 *
 * An unofficial workaround for an Obsidian Live Preview bug where restored fold
 * ranges can extend beyond their current Markdown structure and hide unrelated
 * content.
 *
 * The whole fix is `src/repair.ts`. `src/autorepair.ts` decides when to run it.
 * This file is just wiring: install it, enable it, forget about it.
 */
export default class FoldRagePlugin extends Plugin {
	settings: FoldRageSettings = { ...DEFAULT_SETTINGS };
	private registry!: EditorRegistry;
	private autoRepair!: FoldAutoRepair;
	/** Present only when the undocumented `enableTestApi` flag is set. */
	api: Record<string, unknown> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registry = new EditorRegistry();
		setActiveRegistry(this.registry);
		this.autoRepair = new FoldAutoRepair(this.registry, () => this.settings);
		// Never fight the user mid-edit.
		this.registry.onEdit((entry) => this.autoRepair.noteEdit(entry.id));

		// Public API: installs our tracking ViewPlugin in every Markdown editor.
		this.registerEditorExtension(registryExtension);

		// The transitions where the corruption shows up: a folded file opening in
		// Live Preview, a file changing inside an existing leaf, and Reading View →
		// Live Preview. Nothing here reacts to typing, cursor movement, scrolling
		// or metadata changes.
		this.registry.onRemount((entry, trigger) => this.autoRepair.schedule(entry, trigger));

		this.registerEvent(
			this.app.workspace.on('file-open', () => this.scheduleForLeaf(this.currentLeaf(), 'file-open')),
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) =>
				this.scheduleForLeaf(leaf, 'active-leaf-change'),
			),
		);
		this.registerEvent(
			// Mode toggles surface here, and they are what makes the corruption
			// accumulate, so every tracked editor is re-checked.
			this.app.workspace.on('layout-change', () => this.autoRepair.scheduleAll('layout-change')),
		);

		// Editors that were already open when the plugin loaded.
		this.app.workspace.onLayoutReady(() => {
			for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
				if (leaf.view instanceof MarkdownView) this.registry.registerFromDom(leaf.view.contentEl);
			}
			this.autoRepair.scheduleAll('plugin-load');
		});

		// The one manual command. Same conservative algorithm as the automatic
		// path — there is no alternate hammer.
		this.addCommand({
			id: 'repair-folds-now',
			name: 'Repair folds now',
			// The command needs an open Markdown editor, so it uses a check callback
			// and hides itself when there is none. No default hotkey is set.
			editorCheckCallback: (checking, _editor, ctx) => {
				const view = ctx instanceof MarkdownView ? ctx : null;
				if (checking) return !!view;
				const entry = this.entryForView(view);
				if (entry) this.autoRepair.repairNow(entry);
				return true;
			},
		});

		this.addSettingTab(new FoldRageSettingTab(this.app, this));

		// Compiled out of released builds entirely: with INCLUDE_TEST_API defined as
		// the literal `false`, esbuild removes this branch and never bundles
		// ./testing at all. See esbuild.config.mjs.
		if (INCLUDE_TEST_API && this.settings.enableTestApi) {
			void import('./testing').then((m) => {
				this.api = m.createTestApi(this, this.registry, this.autoRepair);
			});
		}
	}

	onunload(): void {
		this.autoRepair?.dispose();
		this.api = null;
		setActiveRegistry(null);
	}

	sessionStats(): { repairs: number; folds: number } {
		const s = this.autoRepair.stats();
		return { repairs: s.repairs, folds: s.folds };
	}

	/** The Markdown editor the user is looking at — never a guess at another pane. */
	entryForView(view: MarkdownView | null): EditorEntry | null {
		if (!view) return null;
		let entry = this.registry.forLeaf(view.leaf);
		if (!entry) entry = this.registry.registerFromDom(view.contentEl);
		if (entry) this.registry.refreshContext(entry, entry.view.state);
		return entry;
	}

	activeEntry(): EditorEntry | null {
		return this.entryForView(this.app.workspace.getActiveViewOfType(MarkdownView));
	}

	private scheduleForLeaf(leaf: WorkspaceLeaf | null, trigger: string): void {
		const entry = this.registry.forLeaf(leaf);
		if (entry) this.autoRepair.schedule(entry, trigger);
		else this.autoRepair.scheduleAll(trigger);
	}

	private currentLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
