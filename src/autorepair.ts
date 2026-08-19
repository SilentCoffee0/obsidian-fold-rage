import { Notice } from 'obsidian';
import type { EditorEntry, EditorRegistry } from './registry';
import { repairFolds, type RepairResult } from './repair';

import type { FoldRageSettings } from './settings';

const LOG_PREFIX = '[FoldRage]';
/** Development-only console output. Off in released builds. */
const DEBUG = false;

/**
 * AUTOMATIC FOLD REPAIR.
 *
 * Checks for the corruption signature on the transitions where it was observed
 * to appear, and corrects only what is actually wrong.
 *
 * Safety properties, in order of importance:
 *  - It reads first and dispatches nothing when the folds are consistent, which
 *    is the overwhelmingly common case. A healthy editor is never touched.
 *  - It never changes which lines are folded, only how far an already-corrupt
 *    fold reaches. Document text is never modified.
 *  - It backs off while typing: a document change defers the next check, so it
 *    cannot fight the user mid-edit.
 *  - Work is debounced per editor and every deferred run re-validates that the
 *    editor still exists, still shows the same file and is still displayed
 *    before doing anything.
 */

/** Fallback when the configured delay is unusable. */
const DEFAULT_DELAY_MS = 150;
/** Do not run within this long of a document change. */
const TYPING_QUIET_MS = 700;

interface Pending {
	timer: number;
	generation: number;
	filePath: string | null;
	trigger: string;
}

export class FoldAutoRepair {
	private pending = new Map<string, Pending>();
	private lastEdit = new Map<string, number>();
	private repairs = 0;
	private foldsRepaired = 0;
	private checks = 0;

	constructor(
		private registry: EditorRegistry,
		private settings: () => FoldRageSettings,
	) {}

	private delay(): number {
		const d = this.settings().repairDelayMs;
		return Number.isFinite(d) && d >= 0 && d <= 1000 ? d : DEFAULT_DELAY_MS;
	}

	/** Called from the CM6 extension on document changes, to back off while typing. */
	noteEdit(editorId: string): void {
		this.lastEdit.set(editorId, Date.now());
	}

	/** Queue a check for one editor. Cheap and idempotent. */
	schedule(entry: EditorEntry, trigger: string): void {
		if (!this.settings().autoRepair) return;
		const existing = this.pending.get(entry.id);
		if (existing) window.clearTimeout(existing.timer);

		const timer = window.setTimeout(() => {
			this.pending.delete(entry.id);
			this.run(entry.id, entry.generation, entry.filePath, trigger);
		}, this.delay());

		this.pending.set(entry.id, {
			timer,
			generation: entry.generation,
			filePath: entry.filePath,
			trigger,
		});
	}

	/** Check every tracked editor — used on plugin load and on layout changes. */
	scheduleAll(trigger: string): void {
		for (const entry of this.registry.all()) this.schedule(entry, trigger);
	}

	/** Immediate, user-invoked repair of one editor. Bypasses the typing back-off. */
	repairNow(entry: EditorEntry): RepairResult | null {
		return this.execute(entry, 'manual', true);
	}

	private run(editorId: string, generation: number, filePath: string | null, trigger: string): void {
		const entry = this.registry.getById(editorId);
		// Stale-operation guards: the editor may have been destroyed, or moved on
		// to another file or mode, while this check was queued.
		if (!entry) return;
		this.registry.refreshContext(entry, entry.view.state);
		if (entry.generation !== generation) return;
		if (entry.filePath !== filePath) return;
		if (!entry.view.dom.isConnected) return;

		const lastEdit = this.lastEdit.get(editorId) ?? 0;
		if (Date.now() - lastEdit < TYPING_QUIET_MS) {
			// Still typing. Try again once the document settles rather than now.
			this.schedule(entry, `${trigger}+deferred-after-edit`);
			return;
		}

		this.execute(entry, trigger, false);
	}

	private execute(entry: EditorEntry, trigger: string, manual: boolean): RepairResult | null {
		// Only Live Preview / Source editors that are actually displayed. A
		// Reading-View leaf keeps a CodeMirror instance whose DOM is out of layout;
		// repairing it there would be pointless work at the wrong moment.
		if (!manual && (entry.view.dom as HTMLElement).offsetParent === null) return null;

		let result: RepairResult;
		try {
			this.checks++;
			result = repairFolds(entry.view);
		} catch (e) {
			console.error(`${LOG_PREFIX} fold repair failed`, e);
			return null;
		}

		if (result.healthy) {
			// Automatic checks stay completely silent on a healthy editor.
			if (manual) new Notice('Fold Rage found no invalid folds.', 4000);
			return result;
		}

		this.repairs++;
		this.foldsRepaired += result.repaired;
		if (DEBUG) {
			console.log(
			`${LOG_PREFIX} repaired ${result.repaired} of ${result.total} fold range(s) in ` +
				`${entry.filePath ?? '(unknown file)'} — trigger: ${trigger}. ` +
				`Folded coverage ${Math.round(result.foldedFractionBefore * 100)}% → ` +
				`${Math.round(result.foldedFractionAfter * 100)}%. Document unchanged.`,
			);
		}
		if (manual || this.settings().showNotifications) {
			new Notice(`Fold Rage repaired ${result.repaired} fold${result.repaired === 1 ? '' : 's'}.`, 5000);
		}
		return result;
	}

	stats(): { checks: number; repairs: number; folds: number } {
		return { checks: this.checks, repairs: this.repairs, folds: this.foldsRepaired };
	}

	dispose(): void {
		for (const p of this.pending.values()) window.clearTimeout(p.timer);
		this.pending.clear();
	}
}
