import fs from 'node:fs';

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Obsidian is an Electron app, so launching it with --remote-debugging-port gives
 * direct scripted access to the real renderer: the actual CodeMirror 6 editor,
 * the actual Live Preview decorations, the actual layout engine. No jsdom, no
 * simulation.
 *
 * Node 22+ ships a global WebSocket, so this needs no dependencies.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForTargets(port, timeoutMs = 45000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await res.json();
			const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
			if (page) return page;
		} catch {
			/* not up yet */
		}
		await sleep(400);
	}
	throw new Error(`no CDP page target on port ${port} within ${timeoutMs}ms`);
}

export class CdpSession {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 0;
		this.pending = new Map();
		this.closed = false;
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.id && this.pending.has(msg.id)) {
				this.pending.get(msg.id)(msg);
				this.pending.delete(msg.id);
			}
		};
		ws.onclose = () => {
			this.closed = true;
			for (const [, resolve] of this.pending) resolve({ error: { message: 'CDP socket closed' } });
			this.pending.clear();
		};
	}

	static async connect(page) {
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = (e) => reject(new Error(`CDP connect failed: ${e?.message ?? e}`));
		});
		return new CdpSession(ws);
	}

	send(method, params = {}, timeoutMs = 60000) {
		if (this.closed) return Promise.reject(new Error('CDP session closed'));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, timeoutMs);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				if (msg.error) reject(new Error(`CDP error ${method}: ${msg.error.message}`));
				else resolve(msg.result);
			});
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/**
	 * Run a real function inside the Obsidian renderer with JSON arguments.
	 * Async functions are awaited on the renderer side.
	 */
	async call(fn, ...args) {
		const expression = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
		const res = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (res.exceptionDetails) {
			const d = res.exceptionDetails;
			throw new Error(`renderer exception: ${d.exception?.description ?? d.text}`);
		}
		return res.result?.value;
	}

	async screenshot(file) {
		const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		if (!res?.data) throw new Error('screenshot failed');
		fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
		return file;
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
	}
}
