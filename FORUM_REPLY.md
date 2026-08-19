I've been running into this one for a long time and it genuinely affects my daily workflow — I keep
large nested task/study notes folded, and losing everything below a fold in Live Preview is pretty
disruptive. I checked again recently, saw it still wasn't resolved, and I do understand the team has
a lot competing for its attention. Eventually I got frustrated enough to dig into it myself, with a
fair amount of AI-assisted debugging along the way.

I ended up calling the workaround **Fold Rage** — "Stay in your range." The name is partly a joke
about the corrupt fold ranges, and partly because after waiting on this bug for a long time I finally
got frustrated enough to dig into it myself. 😅

## What I found

I reproduced the fault in a real, live broken editor and captured the CodeMirror state before
anything could disturb it. **The fold ranges themselves are corrupt** — this isn't primarily a
rendering or measurement problem.

The same fold, healthy and broken:

```
GOOD:   (407, 1173)
BROKEN: (407, 15989)
```

`15989` was the document length. The fold **start** stays correct; the **end** expands to the end of
the file, so that one fold hides everything after it.

In that capture, **31 of 71 folds** were affected and about 99.8% of the note counted as folded — so
CodeMirror was quite correctly rendering almost nothing.

One detail I think is worth flagging: `contentHeight` and the measured `contentDOM` height **agreed
with each other** in the broken state. Nothing was stale. The renderer was faithfully drawing a fold
set that was itself wrong.

That also explains why the usual remedies don't help. Tried against the actual broken editor:

```
requestMeasure()                 → still broken
double-frame requestMeasure      → still broken
harmless no-op transaction       → still broken
reapply existing folds           → still broken
exact unfold → restore           → still broken
structural fold re-derivation    → repaired
```

Unfold → restore fails because it faithfully restores the same corrupt ranges. That's why the
commonly suggested "unfold and refold" workaround is unreliable.

What worked was re-deriving each fold from its own existing start using `foldable()` and shrinking
any fold whose stored end reached past its current structural boundary. On the real broken editor
that restored rendering immediately, with the fold count and the note text unchanged.

The repair is deliberately conservative: it can only ever **shrink** a fold, never expand one; it
only acts on the proven end-of-document overreach signature; it leaves healthy folds and
legitimately shorter folds completely alone; and if the structural range can't be determined it does
nothing rather than guessing.

## Links

Community Directory:
https://community.obsidian.md/plugins/fold-rage

GitHub:
https://github.com/SilentCoffee0/obsidian-fold-rage

Findings:
https://github.com/SilentCoffee0/obsidian-fold-rage/blob/main/FINDINGS.md

Release (0.1.2):
https://github.com/SilentCoffee0/obsidian-fold-rage/releases/tag/0.1.2

The directory page has an **Add to Obsidian** button. It may not show up in the in-app Community
Plugins search yet while the listing settles — if anyone affected wants to try it in the meantime, it
also installs through BRAT by adding the GitHub repository URL.

On the verification side, since this is a plugin that mutates fold state I wanted it to be checkable
rather than trusted: the regression suite runs 18/18 checks against a real Obsidian instance (not a
simulation), releases are built by CI from the tagged commit and are byte-for-byte reproducible, and
`main.js` carries a GitHub build-provenance attestation. The Community Directory's automated review
passes on release provenance, network requests, dependencies, code obfuscation and build
verification. The one note it still shows is a legacy settings-API warning, which I've kept
deliberately so the plugin can continue to support Obsidian 1.5.8+.

## For the devs

I want to be clear that I have **not** seen Obsidian's source and I'm not claiming to know the exact
internal patch. What the evidence supports is an invariant:

> Restored or persisted fold endpoints should be validated against the currently structurally
> foldable range. A stale stored endpoint should not be allowed to extend a fold beyond its current
> Markdown structure.

The accumulation across repeated Reading ↔ Editing switches is at least *consistent* with a restore
path that takes the larger of the structural end and a stored end, so a fold can only ever grow —
but that part is my hypothesis, not something I observed directly, and I've labelled it as such in
FINDINGS.md.

I'm using this as my workaround for now. Hopefully the captured state and reference implementation
save the team some investigation time and help get the underlying bug fixed properly in one of the
next updates. Obsidian is a huge part of my workflow, which is honestly why I cared enough to spend
this much time chasing one folding bug. Thanks for all the work you guys put into it.
