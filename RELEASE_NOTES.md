Fold Rage is an unofficial temporary workaround / reference implementation for an Obsidian Live
Preview folding bug.

**Stay in your range.**

### What it does

- automatically detects over-reaching corrupt folds
- shrinks them back to their current structural Markdown boundary
- leaves healthy folds untouched
- never modifies note text
- runs silently by default

A fold whose end has expanded past its Markdown block hides everything after it, so Live Preview
looks truncated:

```
GOOD:   (407, 1173)
BROKEN: (407, 15989)      15989 = document length
```

In one captured broken editor, 31 of 71 folds were affected and ~99.8% of the note counted as folded.

`requestMeasure()`, double-frame `requestMeasure()`, a no-op transaction, reapplying the folds, and a
full exact unfold → restore were all tried against the real broken editor and all failed — they
restore the same corrupt ranges. Only re-deriving each fold from its own start with `foldable()`
worked.

### Compatibility

Verified against Obsidian 1.5.8, 1.12.4 and 1.13.7. `minAppVersion` is the oldest version actually
tested, not a guess.

### Installation

**BRAT — recommended**

Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat), run
`BRAT: Plugins: Add a beta plugin for testing` from the Command Palette, and paste:

```
https://github.com/SilentCoffee0/obsidian-fold-rage
```

BRAT also makes receiving future releases easy.

**Manual**

Download `main.js` and `manifest.json` below (or the `.zip`) and place them in:

```
<Vault>/.obsidian/plugins/fold-rage/
```

Reload Obsidian and enable **Fold Rage** under Community plugins.

### Important

The proper solution ultimately belongs in Obsidian core. This plugin is intended as a conservative
workaround and executable reference implementation. See
[FINDINGS.md](https://github.com/SilentCoffee0/obsidian-fold-rage/blob/main/FINDINGS.md) for the full
technical detail and the suggested core-side invariant.
