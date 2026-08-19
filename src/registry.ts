import { MarkdownView, WorkspaceLeaf, editorInfoField, editorLivePreviewField } from 'obsidian';
import type { ViewUpdate, PluginValue } from '@codemirror/view';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';

/**
 * Tracks the live CodeMirror 6 EditorView behind each Obsidian Markdown editor.
 *
 * The view comes from a ViewPlugin installed through the public
 * `Plugin.registerEditorExtension()`, which Obsidian instantiates once per
 * EditorView — so split panes, two panes of the same file, and background tabs
 * each get their own identity and are never confused with one another.
 * `(view.editor as any).cm` is not used.
 */

export interface EditorEntry {
	/** Stable id for this EditorView instance. */
	id: string;
	view: EditorView;
	leaf: WorkspaceLeaf | null;
	filePath: string | null;
	livePreview: boolean | null;
	markdownMode: string | null;
	/** Bumped when this editor mounts a different file or mode; Obsidian reuses views. */
	generation: number;
}

export type RemountListener = (entry: EditorEntry, trigger: string) => void;
export type EditListener = (entry: EditorEntry) => void;

export class EditorRegistry {
	private entries = new Map<EditorView, EditorEntry>();
	private byId = new Map<string, EditorEntry>();
	private nextId = 1;
	private remountListeners: RemountListener[] = [];
	private editListeners: EditListener[] = [];

	onRemount(l: RemountListener): void {
		this.remountListeners.push(l);
	}

	/** Fired on document changes, so consumers can back off while the user types. */
	onEdit(l: EditListener): void {
		this.editListeners.push(l);
	}

	register(view: EditorView): EditorEntry {
		const existing = this.entries.get(view);
		if (existing) return existing;
		const entry: EditorEntry = {
			id: `ed-${this.nextId++}`,
			view,
			leaf: null,
			filePath: null,
			livePreview: null,
			markdownMode: null,
			generation: 0,
		};
		this.entries.set(view, entry);
		this.byId.set(entry.id, entry);
		this.refreshContext(entry, view.state);
		this.emit(entry, 'editor-created');
		return entry;
	}

	unregister(view: EditorView): void {
		const entry = this.entries.get(view);
		if (!entry) return;
		this.entries.delete(view);
		this.byId.delete(entry.id);
	}

	handleUpdate(update: ViewUpdate): void {
		const entry = this.entries.get(update.view);
		if (!entry) return;
		if (update.docChanged) {
			for (const l of this.editListeners) {
				try {
					l(entry);
				} catch {
					/* a listener must never break the editor */
				}
			}
		}
		const prevFile = entry.filePath;
		const prevLive = entry.livePreview;
		const prevMode = entry.markdownMode;
		if (!this.refreshContext(entry, update.state)) return;
		if (prevFile !== entry.filePath) {
			entry.generation++;
			this.emit(entry, 'file-changed-in-editor');
		} else if (prevLive !== entry.livePreview || prevMode !== entry.markdownMode) {
			entry.generation++;
			this.emit(entry, 'editor-mode-changed');
		}
	}

	/** Re-read file / leaf / mode from the CM6 state. Returns true when anything changed. */
	refreshContext(entry: EditorEntry, state: EditorState): boolean {
		let filePath: string | null = null;
		let leaf: WorkspaceLeaf | null = null;
		let markdownMode: string | null = null;
		try {
			const info = state.field(editorInfoField, false);
			if (info) {
				filePath = info.file?.path ?? null;
				if (info instanceof MarkdownView) {
					leaf = info.leaf ?? null;
					try {
						markdownMode = info.getMode();
					} catch {
						markdownMode = null;
					}
				}
			}
		} catch {
			/* field absent */
		}
		let livePreview: boolean | null = null;
		try {
			livePreview = state.field(editorLivePreviewField, false) ?? null;
		} catch {
			/* field absent */
		}

		const changed =
			entry.filePath !== filePath ||
			entry.leaf !== leaf ||
			entry.livePreview !== livePreview ||
			entry.markdownMode !== markdownMode;
		entry.filePath = filePath;
		entry.livePreview = livePreview;
		entry.markdownMode = markdownMode;
		if (leaf) entry.leaf = leaf;
		return changed;
	}

	getById(id: string): EditorEntry | null {
		return this.byId.get(id) ?? null;
	}

	all(): EditorEntry[] {
		return [...this.entries.values()];
	}

	forLeaf(leaf: WorkspaceLeaf | null): EditorEntry | null {
		if (!leaf) return null;
		for (const entry of this.entries.values()) if (entry.leaf === leaf) return entry;
		return null;
	}

	/**
	 * Public CodeMirror fallback for editors that already existed when the plugin
	 * loaded, before the editor extension could register them.
	 */
	registerFromDom(root: HTMLElement | null): EditorEntry | null {
		if (!root) return null;
		try {
			const view = EditorView.findFromDOM(root);
			return view ? this.register(view) : null;
		} catch {
			return null;
		}
	}

	private emit(entry: EditorEntry, trigger: string): void {
		for (const l of this.remountListeners) {
			try {
				l(entry, trigger);
			} catch (e) {
				console.error('[FoldRage] remount listener failed', e);
			}
		}
	}
}

let active: EditorRegistry | null = null;

export function setActiveRegistry(reg: EditorRegistry | null): void {
	active = reg;
}

/** Registered via `Plugin.registerEditorExtension`. Renders nothing, dispatches nothing. */
class RegistryViewPlugin implements PluginValue {
	constructor(private view: EditorView) {
		active?.register(view);
	}

	update(update: ViewUpdate): void {
		if (!update.docChanged && !update.transactions.length) return;
		active?.handleUpdate(update);
	}

	destroy(): void {
		active?.unregister(this.view);
	}
}

export const registryExtension = ViewPlugin.fromClass(RegistryViewPlugin);
