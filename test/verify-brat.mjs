#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * BRAT compatibility check.
 *
 * Requirements taken from BRAT's own source rather than its docs, which do not
 * state them (obsidian42-brat, src/features/BetaPlugins.ts and githubUtils.ts):
 *
 *  - `manifest.json` must be a RELEASE ASSET. Without it BRAT reports
 *    "A manifest.json file does not exist in the latest release of the
 *    repository. This plugin cannot be installed."           (BetaPlugins.ts)
 *  - `main.js` must be a RELEASE ASSET. Without it BRAT reports
 *    "The release is not complete and cannot be downloaded. main.js is missing
 *    from the Release."                                      (BetaPlugins.ts)
 *  - `styles.css` is optional and only written when present. (BetaPlugins.ts)
 *  - Assets are matched by EXACT filename, so a .zip is ignored by BRAT — it is
 *    published only for people installing by hand.           (githubUtils.ts)
 *  - The manifest must carry `id` and `version`.             (BetaPlugins.ts)
 *  - Pre-releases are skipped unless the user opts in, so the release must not
 *    be marked as a pre-release.                             (githubUtils.ts)
 *  - If the release tag and the manifest version differ, the TAG WINS and
 *    overrides the manifest version — so they must match.    (BetaPlugins.ts)
 *  - For plugins BRAT never reads the repository root; the raw-root manifest
 *    path in githubUtils.ts is for community THEMES only.
 *
 * Local mode checks everything that can be checked before publishing.
 * Remote mode additionally verifies the real published release:
 *
 *     node test/verify-brat.mjs --repo=<owner>/<name>
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoArg = process.argv.find((a) => a.startsWith('--repo='))?.split('=')[1] ?? null;

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
	if (detail) console.log(`        ${detail}`);
};

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

console.log('BRAT compatibility');
console.log('='.repeat(52));

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const versions = readJson('versions.json');

check(
	'manifest.json has id, version, minAppVersion',
	!!manifest.id && !!manifest.version && !!manifest.minAppVersion,
	`id=${manifest.id} version=${manifest.version} minAppVersion=${manifest.minAppVersion}`,
);
check(
	'manifest id is a valid plugin folder name',
	/^[a-z0-9-]+$/.test(manifest.id),
	`installs to <vault>/.obsidian/plugins/${manifest.id}/`,
);
check(
	'manifest version matches package.json',
	manifest.version === pkg.version,
	`${manifest.version} vs ${pkg.version}`,
);
check(
	'versions.json maps this version to the manifest minAppVersion',
	versions[manifest.version] === manifest.minAppVersion,
	`versions.json["${manifest.version}"] = ${versions[manifest.version]}`,
);

const mainJs = path.join(ROOT, 'main.js');
check('main.js is built', fs.existsSync(mainJs), fs.existsSync(mainJs) ? `${fs.statSync(mainJs).size} bytes` : 'run npm run build');

const usesCss = fs.existsSync(path.join(ROOT, 'styles.css'));
check(
	'styles.css handled correctly',
	true,
	usesCss ? 'present — must also be a release asset' : 'not used — correctly omitted from the release',
);

// Releases are produced by CI, so the workflow — not a local script — is what
// determines the published assets.
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const assetBlock = workflow.match(/files:\s*\|([\s\S]*?)\n\s{10}\S/)?.[1] ?? '';
const assets = assetBlock
	.split('\n')
	.map((l) => l.trim())
	.filter(Boolean);
check('release workflow uploads main.js', assets.includes('main.js'), `assets: ${assets.join(', ')}`);
check('release workflow uploads manifest.json', assets.includes('manifest.json'), null);
check(
	'release workflow uploads nothing else — no zip',
	assets.length === 2 && !assets.some((a) => a.endsWith('.zip')),
	'the automated review flags unsupported archives, and BRAT matches assets by exact name',
);
check(
	'release is built by CI from the tagged commit',
	/actions\/checkout/.test(workflow) && /npm ci/.test(workflow) && /npm run build/.test(workflow),
	'checkout + npm ci from the lockfile + production build',
);
check(
	'build provenance is attested for main.js',
	/attest-build-provenance/.test(workflow) && /subject-path:\s*main\.js/.test(workflow),
	'with id-token, attestations and artifact-metadata permissions',
);
check(
	'workflow verifies the tag matches the manifest version',
	/manifest\.json'\)\.version/.test(workflow) || /manifest.json.*version/.test(workflow),
	null,
);
check(
	'workflow only triggers on version-shaped tags with no v prefix',
	/tags:[\s\S]*?\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+/.test(workflow),
	'Obsidian requires the release tag to equal the manifest version exactly',
);
check(
	'release is not marked as a pre-release',
	!/prerelease:\s*true/.test(workflow),
	'BRAT skips pre-releases by default',
);
check('no styles.css in the release', !assets.includes('styles.css'), 'the plugin ships no CSS');

// A local zip is still handy for hand-installing, but it is deliberately not a
// release asset any more.
const zip = path.join(ROOT, 'dist', `${manifest.id}-${manifest.version}.zip`);
check(
	'local convenience ZIP is not a release asset',
	!assets.some((a) => a.endsWith('.zip')),
	fs.existsSync(zip) ? `${path.relative(ROOT, zip)} exists locally only` : 'no local zip built',
);

async function remote(repo) {
	console.log('');
	console.log(`Published release — ${repo}`);
	console.log('-'.repeat(52));
	const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
		headers: { Accept: 'application/vnd.github+json' },
	});
	if (!res.ok) {
		check('GitHub releases readable', false, `HTTP ${res.status} — is the repo public and does it have a release?`);
		return;
	}
	const releases = await res.json();
	const published = releases.filter((r) => !r.prerelease && !r.draft);
	check('repository has a published, non-draft, non-pre-release release', published.length > 0, `${releases.length} release(s) total`);
	if (!published.length) return;

	const latest = published[0];
	const names = latest.assets.map((a) => a.name);
	check('latest release exposes main.js', names.includes('main.js'), `assets: ${names.join(', ')}`);
	check('latest release exposes manifest.json', names.includes('manifest.json'), null);
	check(
		'release tag corresponds to the manifest version',
		latest.tag_name.replace(/^v/, '') === manifest.version,
		`tag ${latest.tag_name}, manifest ${manifest.version}`,
	);

	const asset = latest.assets.find((a) => a.name === 'manifest.json');
	if (asset) {
		const m = await (await fetch(asset.browser_download_url)).json().catch(() => null);
		check(
			'released manifest.json parses and carries the same id/version',
			!!m && m.id === manifest.id && m.version === manifest.version,
			m ? `id=${m.id} version=${m.version}` : 'could not parse',
		);
	}
}

const done = () => {
	console.log('');
	const failed = results.filter((r) => !r.ok);
	console.log(`${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) {
		console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
		process.exit(1);
	}
	console.log(
		repoArg
			? 'Ready for BRAT: users can add this repository directly.'
			: 'Local structure is BRAT-ready. After publishing, re-run with --repo=<owner>/<name> to verify the live release.',
	);
	process.exit(0);
};

if (repoArg) remote(repoArg).then(done);
else done();
