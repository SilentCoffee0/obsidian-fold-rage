# Fold Rage 😤

**Stay in your range.**

Fold Rage is an unofficial workaround for an Obsidian Live Preview bug where restored fold ranges can
extend beyond their current Markdown structure and hide unrelated content.

Install it, enable it, forget about it. It has one job.

---

## Why "Fold Rage"?

After waiting on this folding bug for quite a while and eventually debugging it myself, the name felt
appropriate: the bug corrupts fold **ranges**, and frustration is what finally motivated the
investigation.

The fix itself is deliberately boring: detect structurally invalid over-reaching folds, shrink them
back to their legitimate boundary, and otherwise do nothing.

## The bug

Some Obsidian Live Preview folds acquire an incorrect **end** position during fold restoration. A
nested fold that should end at its own Markdown block instead extends to the end of the document, so
everything after it disappears — because CodeMirror legitimately considers it folded.

Your notes are never damaged. Only the fold ranges are wrong.

It shows up after folding a nested list and then switching between Reading View and Live Preview a
few times, and tends to get worse the more you switch.

```
GOOD:   (407, 1173)
BROKEN: (407, 15989)

15989 = document length
```

The **start** is still correct. The **end** has jumped to the end of the file. In one captured broken
editor, **31 of 71 folds** were affected and ~99.8% of the note counted as folded.

## Features

- Automatic quiet repair
- Repairs only the known over-reaching fold corruption
- Never expands a fold — it can only shrink one back to its structural boundary
- Leaves healthy folds untouched
- Never modifies your Markdown
- One manual fallback command
- BRAT installation supported

If every fold is valid, Fold Rage dispatches nothing and says nothing. A healthy editor should not
know it is installed.

## Install

### Install with BRAT — recommended

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from GitHub and makes
receiving new releases easy, so you never have to download anything by hand.

1. Install **BRAT** from Obsidian Community Plugins.
2. Enable BRAT.
3. Open the Command Palette.
4. Run:

   ```
   BRAT: Plugins: Add a beta plugin for testing
   ```

5. Paste:

   ```
   https://github.com/SilentCoffee0/obsidian-fold-rage
   ```

6. Add / install the plugin.
7. Enable **Fold Rage** under Settings → Community plugins.

BRAT also handles updates: when a new release is published here, BRAT can pull it in automatically at
startup, or on demand with `BRAT: Plugins: Check for updates to all beta plugins and UPDATE`.

### Manual installation

Download the latest [release](../../releases/latest) and copy:

```
main.js
manifest.json
```

into:

```
<Vault>/.obsidian/plugins/fold-rage/
```

Then reload Obsidian and enable **Fold Rage** under Settings → Community plugins.

This plugin ships no CSS, so there is no `styles.css`.

### From source

```bash
npm install
npm run build
```

## Usage

There is nothing to do. Automatic repair is on by default.

One command exists as a fallback, for a case the automatic trigger misses:

```
Repair folds now
```

Obsidian shows it as **Fold Rage: Repair folds now** in the command palette — it adds the plugin name
itself, so the command does not repeat it.

It runs exactly the same conservative repair as the automatic path.

### Settings

| Setting | Default | |
|---|---|---|
| Automatic repair | on | Automatically repair over-reaching fold ranges in Live Preview. |
| Repair delay | 150 ms | How long to wait before checking a newly opened or restored editor, so Live Preview can finish restoring its folds. |
| Show repair notifications | off | Notify only when an automatic repair actually changed something. |
| Show session repair count | off | Shows a count inside this settings page. Nothing is stored or sent. |

No telemetry, no analytics, no network requests, nothing leaves your vault.

## Safety

Fold Rage may **shrink** an over-reaching fold. It can never **expand** one — a candidate requires
the stored end to exceed the structural end, so expansion is unreachable by construction.

It never:

- modifies note text or frontmatter
- runs Fold All or Unfold All
- touches a fold that is already valid, or one that is legitimately *shorter* than its structural range
- treats nesting as evidence of corruption — a parent fold containing child folds is normal
- guesses when the structural range cannot be determined; it does nothing and leaves the fold alone
- operates on a pane other than the one it scheduled work for — every editor is tracked separately,
  and a queued repair aborts if the file, mode or editor changed in the meantime
- reacts to typing, cursor movement, scrolling or metadata changes

If Fold Rage changes a fold unexpectedly, please open a GitHub issue with your Obsidian version and
reproduction steps.

## Verify it yourself

```bash
npm run verify        # the fix, against a real Obsidian instance
npm run verify:brat   # the release layout, against BRAT's actual requirements
```

`npm run verify` launches a **real** Obsidian desktop instance against a disposable vault built
inside this repository — your own vault and Obsidian config are never touched, because the launcher
passes its own `--user-data-dir` — and drives the real renderer over the Chrome DevTools Protocol. A
fold-rendering bug cannot be verified anywhere that has no layout, so there is no jsdom here.

It checks, among other things, that a healthy note causes zero repair transactions, that injected
corruption is detected and shrunk to the structural boundary, that rendering is restored, that fold
count, note text and selection are unchanged, that a legitimately shorter fold is left alone, that a
stale queued repair aborts when the file changes, and that notifications stay silent when disabled.

## Distribution notes

`npm run verify:brat` checks the release layout against what BRAT actually requires. Those
requirements come from BRAT's source rather than its documentation, which does not state them
([`BetaPlugins.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/BetaPlugins.ts),
[`githubUtils.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/githubUtils.ts)):

- `main.js` and `manifest.json` must be **release assets**, matched by exact filename
- `styles.css` is optional and only installed when present
- the manifest needs `id` and `version`
- the release must not be marked as a pre-release, which BRAT skips by default
- if the release tag and the manifest version differ, **the tag wins** and overrides the manifest
  version, so they are kept in sync
- the `.zip` is ignored by BRAT; it exists only for manual installs
- for plugins, BRAT reads the release only — never the repository root

After publishing, verify the live release with:

```bash
node test/verify-brat.mjs --repo=SilentCoffee0/obsidian-fold-rage
```

## Note for the Obsidian core team

This is an **unofficial workaround and reference implementation**. It corrects the symptom in user
space; the proper fix belongs in core fold-restoration logic.

We have not inspected Obsidian's private source and make no claim about the exact internal patch.
What the evidence supports is an invariant:

> Restored or persisted fold endpoints should be validated against the currently structurally
> foldable range. A stale stored endpoint should not be allowed to extend a fold beyond its current
> Markdown structure.

[`FINDINGS.md`](FINDINGS.md) has the technical detail, including the full candidate matrix and which
common refresh fixes were tried against a genuinely broken editor and failed.

## Compatibility

Verified against Obsidian **1.5.8**, **1.12.4** and **1.13.7** on macOS, by running the full
verification suite above against each. `minAppVersion` is set to the oldest version actually tested
rather than a guess.

Desktop and mobile: the plugin uses no Node or Electron APIs, so `isDesktopOnly` is `false`. The
automated verification runs on desktop only, since it drives a real desktop Obsidian.

## License

MIT.
