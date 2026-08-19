import type { EditorView } from '@codemirror/view';
import { foldable, foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language';

/**
 * TEST-ONLY helpers. Never reachable in a normal install: they are used solely
 * by `test/verify.mjs`, through an API that only exists when the undocumented
 * `enableTestApi` flag is set in the plugin's data.json (which the disposable
 * test vault writes, and the settings UI does not expose).
 */

/** Fold the given 1-based lines using the registered fold services. */
export function foldLines(view: EditorView, lines: number[]): number {
	const state = view.state;
	const effects = [];
	for (const n of lines) {
		if (n < 1 || n > state.doc.lines) continue;
		const line = state.doc.line(n);
		const range = foldable(state, line.from, line.to);
		if (range && range.from < range.to) effects.push(foldEffect.of(range));
	}
	if (effects.length) view.dispatch({ effects, scrollIntoView: false });
	return effects.length;
}

/**
 * Reproduce the observed corruption signature: keep each fold's start, push its
 * end to the end of the document.
 */
export function simulateFoldCorruption(view: EditorView, count = 3): number {
	const doc = view.state.doc;
	const targets: { from: number; to: number }[] = [];
	const cursor = foldedRanges(view.state).iter();
	while (cursor.value !== null && targets.length < count) {
		targets.push({ from: cursor.from, to: cursor.to });
		cursor.next();
	}
	if (!targets.length) return 0;
	view.dispatch({
		effects: [
			...targets.map((r) => unfoldEffect.of(r)),
			...targets.map((r) => foldEffect.of({ from: r.from, to: doc.length })),
		],
		scrollIntoView: false,
	});
	return targets.length;
}

/**
 * Shrink a fold to LESS than its structural range — a legitimately shorter fold.
 * The repair must leave this completely alone.
 */
export function makeShorterThanStructural(view: EditorView): { from: number; to: number } | null {
	const state = view.state;
	const cursor = foldedRanges(state).iter();
	if (cursor.value === null) return null;
	const from = cursor.from;
	const to = cursor.to;
	const shorter = Math.max(from + 1, Math.floor((from + to) / 2));
	if (shorter >= to) return null;
	view.dispatch({
		effects: [unfoldEffect.of({ from, to }), foldEffect.of({ from, to: shorter })],
		scrollIntoView: false,
	});
	return { from, to: shorter };
}

// ── test API ────────────────────────────────────────────────────────────────
// Everything below is reachable only from `test/verify.mjs`, and only in a build
// produced by `npm run build:test`. The released build defines INCLUDE_TEST_API
// as `false`, so main.ts never imports this module and esbuild does not bundle it.

import type { EditorRegistry } from './registry';
import { auditFolds, listFoldRanges } from './repair';

interface TestHost {
	activeEntry(): { id: string; view: EditorView; filePath: string | null; markdownMode: string | null } | null;
	settings: object;
	// `App.commands` is not in the public typings; only the test API touches it.
	app: object;
}

interface RepairHost {
	repairNow(entry: never): unknown;
	stats(): { checks: number; repairs: number; folds: number };
}

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

export function createTestApi(
	plugin: TestHost,
	registry: EditorRegistry,
	autoRepair: RepairHost,
): Record<string, unknown> {
	const resolve = (editorId?: string) =>
		editorId ? registry.getById(editorId) : (plugin.activeEntry() as never as ReturnType<EditorRegistry['getById']>);

	return {
		audit: (editorId?: string) => {
			const entry = resolve(editorId);
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
			registry.all().map((e) => {
				registry.refreshContext(e, e.view.state);
				return { editorId: e.id, file: e.filePath, mode: e.markdownMode, generation: e.generation };
			}),
		repair: (editorId?: string) => {
			const entry = resolve(editorId);
			return entry ? autoRepair.repairNow(entry as never) : null;
		},
		foldLines: (lines: number[], editorId?: string) => {
			const entry = resolve(editorId);
			return entry ? foldLines(entry.view, lines) : 0;
		},
		simulateCorruption: (n = 3, editorId?: string) => {
			const entry = resolve(editorId);
			return entry ? simulateFoldCorruption(entry.view, n) : 0;
		},
		makeShorterFold: (editorId?: string) => {
			const entry = resolve(editorId);
			return entry ? makeShorterThanStructural(entry.view) : null;
		},
		stats: () => autoRepair.stats(),
		settings: () => ({ ...plugin.settings }),
		commands: () => {
			const registry = (plugin.app as { commands?: { commands?: Record<string, unknown> } }).commands;
			return Object.keys(registry?.commands ?? {}).filter((k) => k.startsWith('fold-rage'));
		},
	};
}
