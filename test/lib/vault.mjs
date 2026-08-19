import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds a disposable vault and an isolated Obsidian user-data directory inside
 * this repository. Nothing outside it is touched: the launcher passes
 * --user-data-dir, so the real Obsidian config and your own vaults are never
 * read or written.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

export function buildVault(root, { pluginDir }) {
	const vault = path.join(root, 'vault');
	const userData = path.join(root, 'userdata');
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.join(vault, '.obsidian', 'plugins', 'fold-rage'), { recursive: true });
	fs.mkdirSync(userData, { recursive: true });

	for (const f of fs.readdirSync(FIXTURES)) {
		fs.copyFileSync(path.join(FIXTURES, f), path.join(vault, f));
	}
	fs.writeFileSync(path.join(vault, 'other-note.md'), '# Other note\n\nUsed to navigate away and back.\n');

	const cfg = path.join(vault, '.obsidian');
	fs.writeFileSync(
		path.join(cfg, 'app.json'),
		JSON.stringify({ legacyEditor: false, livePreview: true, foldHeading: true, foldIndent: true, promptDelete: false }, null, 2),
	);
	fs.writeFileSync(path.join(cfg, 'appearance.json'), JSON.stringify({ theme: 'obsidian', cssTheme: '' }, null, 2));
	fs.writeFileSync(path.join(cfg, 'core-plugins.json'), JSON.stringify({ 'file-explorer': true, 'command-palette': true }, null, 2));
	fs.writeFileSync(path.join(cfg, 'community-plugins.json'), JSON.stringify(['fold-rage'], null, 2));

	const dest = path.join(cfg, 'plugins', 'fold-rage');
	for (const file of ['main.js', 'manifest.json']) {
		const src = path.join(pluginDir, file);
		if (!fs.existsSync(src)) throw new Error(`missing build artifact: ${src} — run "npm run build" first`);
		fs.copyFileSync(src, path.join(dest, file));
	}
	fs.writeFileSync(
		path.join(dest, 'data.json'),
		JSON.stringify({ autoRepair: true, notifyOnRepair: false, debugLogging: true, enableTestApi: true }, null, 2),
	);

	fs.writeFileSync(
		path.join(userData, 'obsidian.json'),
		JSON.stringify({ vaults: { foldrepairtest01: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true }, null, 2),
	);
	return { vault, userData, config: cfg };
}
