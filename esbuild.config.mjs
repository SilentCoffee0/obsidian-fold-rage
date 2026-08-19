import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const banner = `/*
Fold Rage — GENERATED/BUNDLED FILE BY ESBUILD.
Source lives in this plugin's src/ directory.
Fold Rage — Stay in your range.
Unofficial workaround for an Obsidian Live Preview fold-range bug.
*/
`;

const prod = process.argv[2] === 'production';
// The test API is compiled out of released builds. `npm run build:test` keeps it
// for test/verify.mjs; `npm run build` — what the release ships — strips it.
const includeTestApi = process.argv.includes('--test-api');

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtinModules,
	],
	define: { INCLUDE_TEST_API: includeTestApi ? 'true' : 'false' },
	format: 'cjs',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	// Syntax-level only: removes provably dead branches (the stripped test API)
	// without mangling names, so the shipped bundle stays reviewable.
	minifySyntax: prod,
	minify: false,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
