# Findings

Technical notes on the Obsidian Live Preview fold truncation, written for developers.

Everything below marked **observed** was measured on a real Obsidian instance. Everything marked
**hypothesis** is inference and is labelled as such. We have not seen Obsidian's source.

## 1. Reproduction behaviour — observed

Live Preview, on a ~240-line note of deeply nested Markdown lists:

```
open the note in Live Preview
  → Unfold all        renders correctly
  → Fold all          renders correctly
  → Reading ↔ Editing, repeatedly
  → Editing eventually renders truncated
```

- the unfolded state renders correctly
- the folded state renders correctly in Reading View
- the folded state in Live Preview becomes truncated after repeated mode switching
- it worsens the more you switch — cumulative, not a single event
- the Markdown file is never modified

The cumulative nature matters. 216 automated trials that folded a note once and performed a single
transition never reproduced it. Repeated fold/unfold plus repeated mode switching in one long-lived
editor reproduced it within minutes.

## 2. Observed signature

Captured from the same document — identical hash, same fold count, same scroll position, same
cursor — in a healthy and a visibly broken state:

```
GOOD:   (407, 1173)
BROKEN: (407, 15989)

15989 = document length
```

The fold **start** remains legitimate. The **end** expands far past the current structural boundary,
to the end of the document.

| | GOOD | BROKEN |
|---|---|---|
| total folds | 71 | 71 |
| over-reaching folds | 2 | **31** |
| merged fold spans | 4 separate spans | **1 span, 37 → 15989** |
| `visibleRanges` | 4 | **1** |
| rendered `.cm-line` | 4 | **1** |
| `contentHeight` | 589.56 | 510.39 |
| `heightMap.height` | 166.56 | 87.39 |
| `contentDOM` height | 736.70 | **736.70 — identical** |

~99.8% of the note ended up folded, so CodeMirror correctly rendered almost nothing.

The last row is the important one: CodeMirror's height model and the measured DOM **agreed** in the
broken state. Nothing was stale. The renderer was faithfully drawing a fold set that was itself
wrong.

## 3. Candidate results — observed

Each candidate was run against the **actual broken editor**, on a state verified broken first:

```
requestMeasure()                 → STILL BROKEN
double-frame requestMeasure      → STILL BROKEN
harmless no-op transaction       → STILL BROKEN
reapply existing folds           → STILL BROKEN
exact unfold → restore           → STILL BROKEN
structural fold re-derivation    → REPAIRED
```

`requestMeasure()` left every observed field byte-identical.

**Why unfold → restore failed:** it faithfully restored the same corrupt ranges. So did reapplying
the folds. That is also why the widely shared "unfold and refold" workaround does not reliably help.

Together these rule out stale measurement, stale viewport, decoration/widget staleness and parser lag
as the primary cause, and identify the fold state itself.

## 4. Structural repair

For each fold currently in `foldedRanges(state)`:

```ts
const line       = doc.lineAt(fold.from);
const structural = foldable(state, line.from, line.to);   // registered fold services

if (!structural)            continue;   // fail closed — cannot determine, do nothing
if (fold.to <= structural.to) continue; // healthy, or legitimately shorter — leave alone

unfoldEffect.of({ from: fold.from, to: fold.to });          // shrink, never expand
foldEffect.of({   from: fold.from, to: structural.to });
```

Gated additionally on the proven signature: the stored end must reach the end of the document, and
the fold must not start on the last line. Nesting is deliberately **not** treated as evidence — a
parent fold containing child folds is normal.

All corrections go out in one transaction carrying **no selection** (CodeMirror's fold state field
calls `clearTouchedFolds(folded, tr.selection.main.head)` on any transaction that sets one, which
would silently drop the fold under the cursor), no `scrollIntoView`, and no document change.

## 5. Validation — observed

On the live broken editor: `contentHeight 411.39 → 490.56`, rendered lines `2 → 5`, `visibleRanges
2 → 5` — identical to the healthy capture. Fold count unchanged at 71. Document hash unchanged.

Automated (`npm run verify`, real Obsidian over CDP, synthetic fixture), 18 checks including:

```
healthy folded note: no over-reaching folds          6 folds, 0 over-reaching
healthy folded note: repair dispatches nothing       repairs performed: 0
corruption is detected                               3 over-reaching, 98% folded
structural repair corrects it                        repaired 3, 0 remain
rendered content is restored                         28 → 3 → 28 lines; 7 → 1 → 7 visibleRanges
fold count preserved                                 6 → 6
note text unchanged                                  hash 778ffd65 → 778ffd65
selection unchanged by a repair
a fold shorter than its structural range is left alone
repeated mounts on a healthy editor cause zero repairs
automatic repair works on Reading View → Live Preview
repairing one pane does not touch the other
```

## 6. Suggested core-side invariant

We have not inspected Obsidian's private source and make no claim about the exact internal patch.
The **observed facts** above support this invariant:

> Restored or persisted fold endpoints should be validated against the currently structurally
> foldable range. A stale stored endpoint should not be allowed to extend a fold beyond its current
> Markdown structure.

**Hypothesis, not observed:** the behaviour is consistent with a restore path of roughly the shape

```
foldEffect.of({ from, to: Math.max(structuralRange.to, storedEndLine.to) })
```

where a stored endpoint can only grow a fold and never shrink it, and clamps to the document end once
it has reached the last line. That would make the damage self-perpetuating — a fold widened once is
saved as ending on the last line, and every later restore re-applies it at the document end — which
would match the observed accumulation across repeated mode transitions (2 of 71 folds affected while
still rendering correctly, 31 of 71 once visibly broken). We cannot confirm the internal shape.

Clamping the restored end to the structural range, rather than taking the maximum, would make the
condition unreachable.
