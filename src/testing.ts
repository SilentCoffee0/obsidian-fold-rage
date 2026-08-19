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
