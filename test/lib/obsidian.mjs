import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import { CdpSession, waitForTargets, sleep } from './cdp.mjs';

/** Launches an isolated Obsidian instance and attaches a CDP session. */

async function freePort(start = 19300) {
	for (let p = start; p < start + 200; p++) {
		const ok = await new Promise((resolve) => {
			const srv = net.createServer();
			srv.once('error', () => resolve(false));
			srv.once('listening', () => srv.close(() => resolve(true)));
			srv.listen(p, '127.0.0.1');
		});
		if (ok) return p;
	}
	throw new Error('no free debugging port');
}

export class ObsidianInstance {
	constructor({ child, session, port, logLines, userData }) {
		this.userData = userData;
		this.child = child;
		this.session = session;
		this.port = port;
		this.logLines = logLines;
	}

	/**
	 * Kill any Obsidian left over from a crashed run that still holds this
	 * user-data dir — Electron's single-instance lock is keyed on that path, so a
	 * stale process makes every later launch silently forward and exit.
	 */
	static killStale(userData) {
		try {
			if (process.platform === 'win32') {
				execSync(`taskkill /F /FI "COMMANDLINE eq *${userData}*"`, { stdio: 'ignore' });
			} else {
				execSync(`pkill -f ${JSON.stringify(`user-data-dir=${userData}`)}`, { stdio: 'ignore' });
			}
		} catch {
			// pkill exits non-zero when nothing matched, which is the normal case.
		}
	}

	static async launch({ binary, userData, headless = false, onLog }) {
		ObsidianInstance.killStale(userData);
		await sleep(500);
		const port = await freePort();
		const logLines = [];
		const args = [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
		// Obsidian must really paint for geometry to be meaningful, so this never
		// runs headless by default; the flag exists only for CI experiments.
		if (headless) args.push('--headless=new');

		const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const record = (tag) => (buf) => {
			for (const line of String(buf).split('\n')) {
				if (!line.trim()) continue;
				logLines.push(`${tag} ${line}`);
				if (logLines.length > 20000) logLines.shift();
				onLog?.(`${tag} ${line}`);
			}
		};
		child.stdout.on('data', record('[obsidian:out]'));
		child.stderr.on('data', record('[obsidian:err]'));

		const page = await waitForTargets(port);
		const session = await CdpSession.connect(page);
		const instance = new ObsidianInstance({ child, session, port, logLines, userData });
		await instance.waitForLayout();
		await instance.trustVaultAndEnablePlugin('fold-rage');
		await instance.waitForApp();
		return instance;
	}

	async waitForLayout(timeoutMs = 60000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const ok = await this.session
				.call(() => !!(window.app && window.app.workspace && window.app.workspace.layoutReady))
				.catch(() => false);
			if (ok) return;
			await sleep(400);
		}
		throw new Error('Obsidian workspace never became layout-ready');
	}

	/**
	 * A freshly created vault starts in Restricted Mode, so community plugins are
	 * listed but never loaded and a "Do you trust the author of this vault?" modal
	 * blocks the UI. Restricted Mode lives in localStorage under
	 * `enable-plugin-<appId>`, keyed on the vault, so it cannot be seeded from
	 * disk before launch — it has to be cleared here.
	 */
	async trustVaultAndEnablePlugin(pluginId) {
		const result = await this.session.call(async (id) => {
			const app = window.app;
			try {
				localStorage.setItem('enable-plugin-' + app.appId, 'true');
			} catch {
				/* ignore */
			}
			app.plugins.setEnable?.(true);
			if (!app.plugins.plugins[id]) await app.plugins.enablePluginAndSave(id);
			await new Promise((r) => setTimeout(r, 800));
			return { loaded: Object.keys(app.plugins.plugins) };
		}, pluginId);
		await this.dismissModals();
		return result;
	}

	/**
	 * Close any modal covering the workspace.
	 *
	 * The trust prompt in particular sits over the editor for the whole run: it
	 * ruins every screenshot as evidence, holds focus away from the editor, and
	 * could plausibly suppress the very fault being hunted. Its own affirmative
	 * button is preferred over the close button, because that is the path
	 * Obsidian expects.
	 */
	async dismissModals(attempts = 5) {
		for (let i = 0; i < attempts; i++) {
			const remaining = await this.session
				.call(() => {
					const wanted = ['trust author and enable plugins', 'trust author'];
					for (const btn of Array.from(document.querySelectorAll('.modal button'))) {
						const label = (btn.textContent || '').trim().toLowerCase();
						if (wanted.some((w) => label.includes(w))) {
							btn.click();
							return document.querySelectorAll('.modal-container').length;
						}
					}
					for (const b of Array.from(document.querySelectorAll('.modal-close-button'))) b.click();
					return document.querySelectorAll('.modal-container').length;
				})
				.catch(() => 0);
			if (!remaining) return true;
			await sleep(400);
		}
		return false;
	}

	/** How many modals are currently covering the workspace. */
	async modalCount() {
		return this.session.call(() => document.querySelectorAll('.modal-container').length).catch(() => 0);
	}

	async waitForApp(timeoutMs = 60000) {
		const deadline = Date.now() + timeoutMs;
		let lastWhy = 'never polled';
		while (Date.now() < deadline) {
			const state = await this.session
				.call(() => {
					const app = window.app;
					if (!app || !app.workspace) return { ready: false, why: 'no app' };
					if (!app.workspace.layoutReady) return { ready: false, why: 'layout not ready' };
	
					return { ready: true, vault: app.vault.getName(), files: app.vault.getMarkdownFiles().length };
				})
				.catch((e) => ({ ready: false, why: String(e) }));
			if (state?.ready) return state;
			lastWhy = state?.why ?? 'unknown';
			await sleep(500);
		}
		throw new Error(
			`Obsidian did not reach a ready state with the diagnostic plugin loaded (last reason: ${lastWhy})`,
		);
	}

	async quit() {
		try {
			await this.session.call(() => {
				window.close();
				return true;
			});
		} catch {
			/* the renderer may already be gone */
		}
		this.session.close();
		await sleep(600);
		try {
			this.child.kill('SIGTERM');
		} catch {
			/* ignore */
		}
		await sleep(800);
		try {
			this.child.kill('SIGKILL');
		} catch {
			/* ignore */
		}
		ObsidianInstance.killStale(this.userData);
	}
}
