import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Everything about the machine is detected, never asked for. */

const MAC_CANDIDATES = ['/Applications/Obsidian.app', path.join(os.homedir(), 'Applications/Obsidian.app')];

const LINUX_CANDIDATES = [
	'/usr/bin/obsidian',
	'/usr/local/bin/obsidian',
	'/opt/Obsidian/obsidian',
	'/var/lib/flatpak/exports/bin/md.obsidian.Obsidian',
	path.join(os.homedir(), '.local/share/flatpak/exports/bin/md.obsidian.Obsidian'),
];

const WIN_CANDIDATES = [
	path.join(process.env.LOCALAPPDATA ?? '', 'Obsidian/Obsidian.exe'),
	path.join(process.env.PROGRAMFILES ?? '', 'Obsidian/Obsidian.exe'),
];

function macVersion(appPath) {
	try {
		return execFileSync('defaults', ['read', path.join(appPath, 'Contents/Info.plist'), 'CFBundleShortVersionString'], {
			encoding: 'utf8',
		}).trim();
	} catch {
		return null;
	}
}

function macElectronVersion(appPath) {
	const plist = path.join(appPath, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist');
	try {
		const raw = fs.readFileSync(plist, 'utf8');
		const m = raw.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

function firstExisting(list) {
	return list.find((p) => p && fs.existsSync(p)) ?? null;
}

export function detectEnvironment() {
	const platform = process.platform;
	const env = {
		platform,
		arch: process.arch,
		osRelease: os.release(),
		node: process.version,
		npm: (() => {
			try {
				return execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim();
			} catch {
				return null;
			}
		})(),
		obsidian: { found: false, appPath: null, binary: null, version: null, electron: null, userDataDefault: null },
	};

	if (platform === 'darwin') {
		try {
			env.osName = execFileSync('sw_vers', ['-productName'], { encoding: 'utf8' }).trim();
			env.osVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
		} catch {
			env.osName = 'macOS';
		}
		const app = firstExisting(MAC_CANDIDATES);
		if (app) {
			env.obsidian = {
				found: true,
				appPath: app,
				binary: path.join(app, 'Contents/MacOS/Obsidian'),
				version: macVersion(app),
				electron: macElectronVersion(app),
				userDataDefault: path.join(os.homedir(), 'Library/Application Support/obsidian'),
			};
		}
	} else if (platform === 'linux') {
		env.osName = 'Linux';
		env.osVersion = os.release();
		const bin = firstExisting(LINUX_CANDIDATES) ?? process.env.OBSIDIAN_BINARY ?? null;
		if (bin) {
			env.obsidian = {
				found: true,
				appPath: bin,
				binary: bin,
				version: null,
				electron: null,
				userDataDefault: path.join(os.homedir(), '.config/obsidian'),
			};
		}
	} else if (platform === 'win32') {
		env.osName = 'Windows';
		env.osVersion = os.release();
		const bin = firstExisting(WIN_CANDIDATES) ?? process.env.OBSIDIAN_BINARY ?? null;
		if (bin) {
			env.obsidian = {
				found: true,
				appPath: bin,
				binary: bin,
				version: null,
				electron: null,
				userDataDefault: path.join(process.env.APPDATA ?? '', 'obsidian'),
			};
		}
	}

	if (process.env.OBSIDIAN_BINARY && fs.existsSync(process.env.OBSIDIAN_BINARY)) {
		env.obsidian.found = true;
		env.obsidian.binary = process.env.OBSIDIAN_BINARY;
	}

	return env;
}

export function requireObsidian(env) {
	if (!env.obsidian.found) {
		throw new Error(
			'Obsidian desktop was not found on this machine.\n' +
				'Install it from https://obsidian.md/download, or set OBSIDIAN_BINARY to the executable path.',
		);
	}
	return env.obsidian;
}
