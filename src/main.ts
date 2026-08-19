import { MarkdownView, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, FoldRageSettingTab, type FoldRageSettings } from './settings';
import { EditorRegistry, registryExtension, setActiveRegistry, type EditorEntry } from './registry';
import { FoldAutoRepair } from './autorepair';

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
			callback: () => {
				const entry = this.activeEntry();
				if (entry) this.autoRepair.repairNow(entry);
			},
		});

		this.addSettingTab(new FoldRageSettingTab(this.app, this));

		if (this.settings.enableTestApi) void this.installTestApi();
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
	private activeEntry(notify = true): EditorEntry | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const leaf = view?.leaf ?? this.app.workspace.activeLeaf ?? null;
		let entry = this.registry.forLeaf(leaf);
		if (!entry && view) entry = this.registry.registerFromDom(view.contentEl);
		if (!entry && notify) new Notice('Fold Rage: no editor found for the active pane.', 5000);
		if (entry) this.registry.refreshContext(entry, entry.view.state);
		return entry;
	}

	private scheduleForLeaf(leaf: WorkspaceLeaf | null, trigger: string): void {
		const entry = this.registry.forLeaf(leaf);
		if (entry) this.autoRepair.schedule(entry, trigger);
		else this.autoRepair.scheduleAll(trigger);
	}

	private currentLeaf(): WorkspaceLeaf | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) return view.leaf;
		const active = this.app.workspace.activeLeaf;
		return active?.view instanceof MarkdownView ? active : null;
	}

	/**
	 * Only for this repository's automated verification, and only when the
	 * undocumented `enableTestApi` flag is set. Loaded lazily so the helpers stay
	 * out of the normal runtime path.
	 */
	private async installTestApi(): Promise<void> {
		const { auditFolds, listFoldRanges } = await import('./repair');
		const { foldLines, simulateFoldCorruption, makeShorterThanStructural } = await import('./testing');
		this.api = {
			audit: (editorId?: string) => {
				const entry = editorId ? this.registry.getById(editorId) : this.activeEntry(false);
				if (!entry) return null;
				const a = auditFolds(entry.view.state);
				const v = entry.view;
				return {
					editorId: entry.id,
					file: entry.filePath,
					mode: entry.markdownMode,
					folds: a.total,
					overReaching: a.corrections.length,
					undeterminable: a.undeterminable,
					foldedFraction: a.foldedFraction,
					foldRanges: listFoldRanges(v.state).map((r) => [r.from, r.to]),
					docLength: v.state.doc.length,
					docHash: hash(v.state.doc.toString()),
					selection: v.state.selection.ranges.map((r) => [r.from, r.to]),
					renderedLines: v.contentDOM.querySelectorAll(':scope > .cm-line').length,
					visibleRanges: v.visibleRanges.length,
					contentHeight: Math.round(v.contentHeight * 100) / 100,
				};
			},
			editors: () =>
				this.registry.all().map((e) => {
					this.registry.refreshContext(e, e.view.state);
					return { editorId: e.id, file: e.filePath, mode: e.markdownMode, generation: e.generation };
				}),
			repair: (editorId?: string) => {
				const entry = editorId ? this.registry.getById(editorId) : this.activeEntry(false);
				return entry ? this.autoRepair.repairNow(entry) : null;
			},
			foldLines: (lines: number[], editorId?: string) => {
				const entry = editorId ? this.registry.getById(editorId) : this.activeEntry(false);
				return entry ? foldLines(entry.view, lines) : 0;
			},
			simulateCorruption: (n = 3, editorId?: string) => {
				const entry = editorId ? this.registry.getById(editorId) : this.activeEntry(false);
				return entry ? simulateFoldCorruption(entry.view, n) : 0;
			},
			makeShorterFold: (editorId?: string) => {
				const entry = editorId ? this.registry.getById(editorId) : this.activeEntry(false);
				return entry ? makeShorterThanStructural(entry.view) : null;
			},
			stats: () => this.autoRepair.stats(),
			settings: () => ({ ...this.settings }),
			setSetting: async (key: string, value: unknown) => {
				(this.settings as unknown as Record<string, unknown>)[key] = value;
				await this.saveSettings();
				return { ...this.settings };
			},
			commands: () => Object.keys((this.app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands).filter((k) => k.startsWith('fold-rage')),
		};
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
