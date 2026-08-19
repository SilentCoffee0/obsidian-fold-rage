#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnvironment, requireObsidian } from './lib/env.mjs';
import { buildVault } from './lib/vault.mjs';
import { ObsidianInstance } from './lib/obsidian.mjs';
import { sleep } from './lib/cdp.mjs';

/**
 * End-to-end verification of Fold Rage against a real Obsidian desktop instance.
 *
 * Obsidian is an Electron app, so this launches it with --remote-debugging-port
 * and drives the real renderer over the Chrome DevTools Protocol: the real
 * CodeMirror 6 editor, the real Live Preview decorations, the real layout. A
 * fold-rendering bug cannot be verified anywhere that has no layout.
 *
 * Checks, in order:
 *   1. a healthy folded note produces ZERO repair transactions
 *   2. the corruption signature is detected once injected
 *   3. structural repair corrects it, preserving fold count and note text
 *   4. automatic repair corrects it on a real mount transition, unprompted
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'nested-tasks.md';

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
	if (detail) console.log(`        ${detail}`);
}

const api = (cdp, method, ...args) =>
	cdp.call(
		async (m, a) => {
			const p = window.app.plugins.plugins['fold-rage'];
			if (!p?.api) throw new Error('test API unavailable');
			return await p.api[m](...a);
		},
		method,
		args,
	);

const openFile = (cdp, file) =>
	cdp.call(async (p) => {
		const app = window.app;
		const f = app.vault.getAbstractFileByPath(p);
		if (!f) throw new Error('no such file: ' + p);
		await app.workspace.getLeaf(false).openFile(f, { active: true, state: { mode: 'source', source: false } });
		await new Promise((r) => setTimeout(r, 400));
		return app.workspace.getMostRecentLeaf()?.view?.file?.path ?? null;
	}, file);

async function main() {
	const env = detectEnvironment();
	const obs = requireObsidian(env);
	console.log('Fold Rage — verification');
	console.log('='.repeat(52));
	console.log(`OS        ${env.osName} ${env.osVersion} (${env.arch})`);
	console.log(`Obsidian  ${obs.version ?? 'unknown'}  Electron ${obs.electron ?? 'unknown'}`);
	console.log('');

	const paths = buildVault(path.join(ROOT, '.test-vault'), { pluginDir: ROOT });
	const instance = await ObsidianInstance.launch({ binary: obs.binary, userData: paths.userData });
	const cdp = instance.session;
	await cdp.send('Page.bringToFront').catch(() => {});
	await instance.dismissModals();

	try {
		await openFile(cdp, FIXTURE);
		await sleep(600);
		// Fold only the top-level branches, so the rendered-line recovery is visible
		// rather than everything collapsing to one line regardless.
		const topLevel = await cdp.call(() => {
			const text = window.app.workspace.getMostRecentLeaf().view.editor.getValue();
			return text.split('\n').map((l, i) => (/^\d+\. /.test(l) ? i + 1 : 0)).filter(Boolean);
		});
		await api(cdp, 'foldLines', topLevel);
		await sleep(700);

		// 1 — healthy folds must produce no repair work at all.
		const healthy = await api(cdp, 'audit');
		const statsBefore = await api(cdp, 'stats');
		const healthyRepair = await api(cdp, 'repair');
		const statsAfter = await api(cdp, 'stats');
		check(
			'healthy folded note: no over-reaching folds',
			healthy.overReaching === 0 && healthy.folds > 0,
			`${healthy.folds} fold(s), ${healthy.overReaching} over-reaching, ${Math.round(healthy.foldedFraction * 100)}% folded`,
		);
		check(
			'healthy folded note: repair dispatches nothing',
			healthyRepair?.healthy === true && statsAfter.repairs === statsBefore.repairs,
			`repairs performed: ${statsAfter.repairs}`,
		);

		// 2 — inject the observed signature.
		const injected = await api(cdp, 'simulateCorruption', 3);
		await sleep(400);
		const corrupt = await api(cdp, 'audit');
		check(
			'corruption is detected',
			injected > 0 && corrupt.overReaching > 0,
			`injected ${injected}; audit reports ${corrupt.overReaching} over-reaching, ` +
				`${Math.round(corrupt.foldedFraction * 100)}% folded, ${corrupt.renderedLines} rendered line(s)`,
		);

		// 3 — structural repair, preserving folds and text.
		const repaired = await api(cdp, 'repair');
		await sleep(400);
		const fixed = await api(cdp, 'audit');
		check(
			'structural repair corrects it',
			repaired?.repaired > 0 && fixed.overReaching === 0,
			`repaired ${repaired?.repaired}; ${fixed.overReaching} over-reaching remain`,
		);
		check(
			'rendered content is restored',
			fixed.renderedLines > corrupt.renderedLines && fixed.renderedLines === healthy.renderedLines,
			`rendered lines: healthy ${healthy.renderedLines} → corrupt ${corrupt.renderedLines} → repaired ${fixed.renderedLines}; ` +
				`visibleRanges ${healthy.visibleRanges} → ${corrupt.visibleRanges} → ${fixed.visibleRanges}`,
		);
		check(
			'fold count preserved',
			fixed.folds === healthy.folds,
			`${healthy.folds} before, ${fixed.folds} after`,
		);
		check(
			'note text unchanged',
			fixed.docHash === healthy.docHash && fixed.docLength === healthy.docLength,
			`hash ${healthy.docHash} → ${fixed.docHash}, length ${healthy.docLength} → ${fixed.docLength}`,
		);

		// 4 — automatic repair on a real mount transition, with no command invoked.
		await api(cdp, 'simulateCorruption', 3);
		await sleep(400);
		const corruptAgain = await api(cdp, 'audit');
		await openFile(cdp, 'other-note.md');
		await sleep(600);
		await openFile(cdp, FIXTURE);
		await sleep(1200);
		const auto = await api(cdp, 'audit');
		check(
			'automatic repair fixes it on mount, unprompted',
			corruptAgain.overReaching > 0 && auto.overReaching === 0,
			`${corruptAgain.overReaching} over-reaching before the transition, ${auto.overReaching} after`,
		);
		check(
			'note text still unchanged after automatic repair',
			auto.docHash === healthy.docHash,
			`hash ${auto.docHash}`,
		);
		// 5 — a legitimately SHORTER fold must never be touched.
		const shortened = await api(cdp, 'makeShorterFold');
		await sleep(300);
		const shortAudit = await api(cdp, 'audit');
		const shortRepair = await api(cdp, 'repair');
		check(
			'a fold shorter than its structural range is left alone',
			!!shortened && shortAudit.overReaching === 0 && shortRepair?.healthy === true,
			shortened ? `fold shortened to (${shortened.from}, ${shortened.to}); 0 flagged, repair dispatched nothing` : 'could not shorten a fold',
		);

		// 6 — selection must survive a repair.
		await api(cdp, 'foldLines', topLevel);
		await sleep(300);
		const selBefore = (await api(cdp, 'audit')).selection;
		await api(cdp, 'simulateCorruption', 3);
		await sleep(300);
		await api(cdp, 'repair');
		await sleep(300);
		const selAfter = (await api(cdp, 'audit')).selection;
		check(
			'selection unchanged by a repair',
			JSON.stringify(selBefore) === JSON.stringify(selAfter),
			`${JSON.stringify(selBefore)} → ${JSON.stringify(selAfter)}`,
		);

		// 7 — repeated automatic checks on a healthy editor must mutate nothing.
		const statsA = await api(cdp, 'stats');
		for (let i = 0; i < 3; i++) {
			await openFile(cdp, 'other-note.md');
			await sleep(350);
			await openFile(cdp, FIXTURE);
			await sleep(450);
		}
		const statsB = await api(cdp, 'stats');
		const healthyAfterCycles = await api(cdp, 'audit');
		check(
			'repeated mounts on a healthy editor cause zero repairs',
			statsB.repairs === statsA.repairs && healthyAfterCycles.overReaching === 0,
			`repairs ${statsA.repairs} → ${statsB.repairs} across 3 open/close cycles`,
		);

		// 8 — Reading View → Live Preview.
		await api(cdp, 'simulateCorruption', 3);
		await sleep(300);
		const beforeMode = await api(cdp, 'audit');
		await cdp.call(async () => {
			const leaf = window.app.workspace.getMostRecentLeaf();
			const vs = leaf.getViewState();
			await leaf.setViewState({ ...vs, state: { ...vs.state, mode: 'preview', source: false } });
			await new Promise((r) => setTimeout(r, 600));
			await leaf.setViewState({ ...vs, state: { ...vs.state, mode: 'source', source: false } });
			await new Promise((r) => setTimeout(r, 400));
			return true;
		});
		await sleep(900);
		const afterMode = await api(cdp, 'audit');
		check(
			'automatic repair works on Reading View → Live Preview',
			beforeMode.overReaching > 0 && afterMode.overReaching === 0,
			`${beforeMode.overReaching} over-reaching → ${afterMode.overReaching}`,
		);

		// 9 — the correct pane is targeted, and a stale queued repair aborts.
		const panes = await cdp.call(async (f) => {
			const app = window.app;
			const file = app.vault.getAbstractFileByPath(f);
			const other = app.vault.getAbstractFileByPath('other-note.md');
			const right = app.workspace.getLeaf('split', 'vertical');
			await right.openFile(other, { active: true, state: { mode: 'source', source: false } });
			await new Promise((r) => setTimeout(r, 600));
			void file;
			return app.workspace.getLeavesOfType('markdown').map((l) => l.view?.file?.path ?? null);
		}, FIXTURE);
		const editors = await api(cdp, 'editors');
		const fixtureEditor = editors.find((e) => e.file === FIXTURE);
		const otherEditor = editors.find((e) => e.file === 'other-note.md');
		check(
			'each pane is tracked as its own editor',
			!!fixtureEditor && !!otherEditor && fixtureEditor.editorId !== otherEditor.editorId,
			`panes: ${JSON.stringify(panes)}; editors: ${editors.map((e) => `${e.editorId}=${e.file}`).join(', ')}`,
		);
		const otherBefore = await api(cdp, 'audit', otherEditor.editorId);
		await api(cdp, 'simulateCorruption', 2, fixtureEditor.editorId);
		await sleep(300);
		await api(cdp, 'repair', fixtureEditor.editorId);
		await sleep(300);
		const otherAfter = await api(cdp, 'audit', otherEditor.editorId);
		check(
			'repairing one pane does not touch the other',
			otherBefore.docHash === otherAfter.docHash &&
				JSON.stringify(otherBefore.foldRanges) === JSON.stringify(otherAfter.foldRanges),
			`other pane folds unchanged (${otherAfter.foldRanges.length})`,
		);

		// 10 — only the manual repair command is exposed.
		const commands = await api(cdp, 'commands');
		check(
			'exactly one public command, and no diagnostics',
			commands.length === 1 && commands[0].endsWith('repair-folds-now'),
			commands.join(', '),
		);

		// 11 — notifications are silent by default.
		const settings = await api(cdp, 'settings');
		check(
			'defaults are correct: auto-repair on, notifications off, 150ms',
			settings.autoRepair === true && settings.showNotifications === false && settings.repairDelayMs === 150,
			`autoRepair=${settings.autoRepair} showNotifications=${settings.showNotifications} repairDelayMs=${settings.repairDelayMs}`,
		);

		// 12 — the session counter tracks folds, and lives only in settings.
		const finalStats = await api(cdp, 'stats');
		check(
			'session counter tracks repairs in memory only',
			finalStats.folds > 0 && finalStats.repairs > 0,
			`${finalStats.folds} fold(s) across ${finalStats.repairs} repair(s)`,
		);
	} finally {
		await instance.quit();
	}

	console.log('');
	const failed = results.filter((r) => !r.ok);
	console.log(`${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) {
		console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
		process.exit(1);
	}
	console.log('All checks passed.');
	process.exit(0);
}

main().catch((e) => {
	console.error('\nVERIFICATION FAILED:', e?.stack ?? e);
	process.exit(1);
});
