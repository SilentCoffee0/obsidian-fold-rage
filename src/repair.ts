import type { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { foldable, foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language';

/**
 * Structural fold-range repair — the whole fix.
 *
 * THE FAULT, from a human-confirmed capture of a genuinely broken editor:
 *
 *   GOOD    (407, 1173)  (559, 1173)  (1073, 1173)
 *   BROKEN  (407, 15989) (559, 15989) (1073, 15989)     15989 = document length
 *
 * The fold START stays legitimate; the END expands past the block the fold
 * belongs to, so one fold hides everything after it. In that capture 31 of 71
 * folds were affected, ~99.8% of the note counted as folded, and CodeMirror
 * correctly rendered almost nothing — the fold set itself was wrong, not the
 * rendering.
 *
 * THE REPAIR: for each fold, keep its start, ask CodeMirror's registered fold
 * services (`foldable()` — the same ones Obsidian's fold gutter uses) for the
 * range that is structurally valid there now, and shrink the fold back to it.
 *
 * CONSERVATISM — the rules this file exists to guarantee:
 *
 *   1. It can only ever SHRINK a fold. Expanding one is unreachable by
 *      construction: a candidate requires `stored.to > structural.to`.
 *   2. It targets the proven overreach signature specifically, not merely
 *      "stored end differs from structural end". A fold that is legitimately
 *      SHORTER than its structural range is left alone, because Obsidian's own
 *      restore path can legitimately produce one.
 *   3. Nesting is never treated as evidence. A parent fold containing child
 *      folds is completely normal, so "swallows a later fold" is deliberately
 *      NOT a trigger.
 *   4. If structural validity cannot be determined — no fold service answers,
 *      the parser has not caught up, a line lookup throws — it does nothing.
 *      Fail closed, never guess.
 *   5. It never modifies document text, and never uses Fold All / Unfold All.
 */

export interface FoldCorrection {
	from: number;
	/** The over-reaching end currently stored. */
	badTo: number;
	/** The structurally valid end it will be shrunk to. */
	goodTo: number;
	fromLine: number;
	overreachChars: number;
}

export interface FoldAudit {
	total: number;
	corrections: FoldCorrection[];
	/** Folds skipped because their structural range could not be determined. */
	undeterminable: number;
	foldedFraction: number;
}

/**
 * Does this fold end at the very end of the document?
 *
 * That is the signature every corrupt fold in the captures had. The threshold is
 * tolerant of the trailing newline: when a note ends with one, the last line
 * starts at `doc.length` while the corrupt folds ended at `doc.length - 1`.
 */
function reachesDocumentEnd(state: EditorState, to: number): boolean {
	const doc = state.doc;
	const lastLineStart = doc.line(doc.lines).from;
	return to >= Math.min(lastLineStart, Math.max(0, doc.length - 1));
}

/**
 * Compare every fold against what its own start line can structurally fold, and
 * report only the ones matching the proven overreach signature.
 */
export function auditFolds(state: EditorState): FoldAudit {
	const doc = state.doc;
	const corrections: FoldCorrection[] = [];
	const ranges: { from: number; to: number }[] = [];
	let undeterminable = 0;

	const lastLineStart = doc.line(doc.lines).from;
	const cursor = foldedRanges(state).iter();
	while (cursor.value !== null) {
		const from = cursor.from;
		const to = cursor.to;
		ranges.push({ from, to });
		cursor.next();

		// A fold that starts on the last line has nothing after it to swallow.
		if (from >= lastLineStart) continue;
		// Signature gate: the observed corruption always ran to the end of the
		// document. Anything else is left alone rather than guessed at.
		if (!reachesDocumentEnd(state, to)) continue;

		let structural: { from: number; to: number } | null = null;
		try {
			const line = doc.lineAt(Math.max(0, Math.min(from, doc.length)));
			structural = foldable(state, line.from, line.to) ?? null;
		} catch {
			structural = null;
		}
		if (!structural) {
			// No fold service could answer for this line. Fail closed.
			undeterminable++;
			continue;
		}
		// Shrink only. If the stored end is at or inside the structural end, this
		// is either healthy or a legitimately shorter fold — leave it alone.
		if (to <= structural.to) continue;

		corrections.push({
			from,
			badTo: to,
			goodTo: structural.to,
			fromLine: doc.lineAt(from).number,
			overreachChars: to - structural.to,
		});
	}

	const sorted = [...ranges].sort((a, b) => a.from - b.from);
	const merged: { from: number; to: number }[] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
		else merged.push({ ...r });
	}
	const hidden = merged.reduce((a, r) => a + (r.to - r.from), 0);

	return {
		total: ranges.length,
		corrections,
		undeterminable,
		foldedFraction: doc.length ? Math.round((hidden / doc.length) * 10000) / 10000 : 0,
	};
}

/** All currently folded ranges, in document order. */
export function listFoldRanges(state: EditorState): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	const cursor = foldedRanges(state).iter();
	while (cursor.value !== null) {
		out.push({ from: cursor.from, to: cursor.to });
		cursor.next();
	}
	return out;
}

export interface RepairResult {
	repaired: number;
	total: number;
	/** True when nothing needed doing — the overwhelmingly common case. */
	healthy: boolean;
	foldedFractionBefore: number;
	foldedFractionAfter: number;
}

/**
 * Shrink over-reaching folds back to their structural boundary, in one
 * transaction.
 *
 * The transaction carries no selection — CodeMirror's fold state field clears
 * folds under the cursor on any transaction that sets one — no `scrollIntoView`,
 * and no document change. When there is nothing to correct it dispatches
 * nothing at all.
 */
export function repairFolds(view: EditorView): RepairResult {
	const before = auditFolds(view.state);
	if (!before.corrections.length) {
		return {
			repaired: 0,
			total: before.total,
			healthy: true,
			foldedFractionBefore: before.foldedFraction,
			foldedFractionAfter: before.foldedFraction,
		};
	}

	view.dispatch({
		effects: [
			...before.corrections.map((c) => unfoldEffect.of({ from: c.from, to: c.badTo })),
			...before.corrections.map((c) => foldEffect.of({ from: c.from, to: c.goodTo })),
		],
		scrollIntoView: false,
	});

	const after = auditFolds(view.state);
	return {
		repaired: before.corrections.length,
		total: before.total,
		healthy: false,
		foldedFractionBefore: before.foldedFraction,
		foldedFractionAfter: after.foldedFraction,
	};
}
