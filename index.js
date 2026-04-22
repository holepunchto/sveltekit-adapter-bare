import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const files = fileURLToPath(new URL('./files', import.meta.url).href);
const inject = fileURLToPath(new URL('./inject.js', import.meta.url).href);
const async_hooks_stub = fileURLToPath(new URL('./async-hooks-stub.js', import.meta.url).href);

/** @type {(opts?: { out?: string }) => import('@sveltejs/kit').Adapter} */
export default function (opts = {}) {
	const { out = 'build' } = opts;

	return {
		name: 'adapter-bare',

		async adapt(builder) {
			const tmp = builder.getBuildDirectory('adapter-bare');

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

			builder.log.minor('Building server');
			builder.writeServer(tmp);

			writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
				].join('\n\n')
			);

			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

			// Redirect node: builtins to bare equivalents so the server bundle
			// resolves correctly in a bare runtime.
			/** @type {Record<string, string>} */
			const bare_aliases = {
				'node:buffer': 'bare-buffer',
				'node:stream': 'bare-stream',
				'node:fs': 'bare-fs',
				'node:fs/promises': 'bare-fs',
				'node:path': 'bare-path',
				'node:url': 'bare-url',
				'node:crypto': 'bare-crypto',
				'node:process': 'bare-process',
				'node:os': 'bare-os',
				'node:events': 'bare-events',
				'node:timers': 'bare-timers',
				buffer: 'bare-buffer',
				stream: 'bare-stream',
				events: 'bare-events',
				'node:async_hooks': async_hooks_stub
			};

			// All runtime deps stay external — bare resolves them at runtime.
			const external = Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]);

			await build({
				entryPoints: {
					index: `${tmp}/index.js`,
					manifest: `${tmp}/manifest.js`
				},
				outdir: `${out}/server`,
				bundle: true,
				format: 'esm',
				platform: 'node',
				splitting: true,
				chunkNames: 'chunks/[name]-[hash]',
				sourcemap: true,
				alias: bare_aliases,
				external,
				// Auto-import bare-fetch/bare-stream types wherever SvelteKit's server
				// references Request, Response, Headers, ReadableStream as globals.
				inject: [inject],
				logLevel: 'warning'
			});

			// SvelteKit uses `obfuscated_import("node:crypto")` as a dynamic
			// fallback when globalThis.crypto is absent. bare-build's static
			// traversal still finds the specifier and fails. Since we set
			// globalThis.crypto at startup the fallback is dead code — patch
			// it out of every generated chunk.
			patch_crypto(join(out, 'server'));

			// bare-module-traverse only picks up assets via STATIC import.meta.asset()
			// calls in source. Declaring globs in package.json is not enough. So we
			// enumerate every file under client/ + prerendered/ and emit an assets.js
			// module with one import.meta.asset() call per file, keyed by URL path.
			// bare-build sees each call and preserves the file; handler.js looks up
			// incoming request paths in the map and serves the resolved path.
			mkdirSync(join(out, 'prerendered'), { recursive: true });
			writeFileSync(join(out, 'assets.js'), generate_assets_module(out));

			builder.copy(files, out, {
				replace: {
					HANDLER: './handler.js',
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js'
				}
			});
		},

		supports: {
			read: () => true
		}
	};
}

/**
 * Replace SvelteKit's lazy `node:crypto` dynamic import fallback in all
 * bundled JS files. The pattern only executes when `globalThis.crypto` is
 * absent; since we set it before anything else runs the branch is dead.
 * @param {string} dir
 */
function patch_crypto(dir) {
	// Matches: ... : (await obfuscated_import("node:crypto")).webcrypto
	const pattern = /\(await obfuscated_import\(["']node:crypto["']\)\)\.webcrypto/g;
	const replacement = 'globalThis.crypto';

	for (const file of js_files(dir)) {
		const src = readFileSync(file, 'utf8');
		if (!pattern.test(src)) continue;
		writeFileSync(file, src.replace(pattern, replacement));
	}
}

/** @param {string} dir @returns {string[]} */
function js_files(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...js_files(full));
		else if (entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}

/**
 * Walk a directory and return all file paths relative to `base`, using
 * forward slashes (URL-style) regardless of platform.
 * @param {string} base @param {string} dir @returns {string[]}
 */
function walk(base, dir = base) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(base, full));
		else out.push(full.slice(base.length + 1).split(/[\\/]/).join('/'));
	}
	return out;
}

/**
 * Emit an ES module with one import.meta.asset() call per static file under
 * client/ and prerendered/. The module exports two maps: { relPath → absPath }.
 * @param {string} out
 * @returns {string}
 */
function generate_assets_module(out) {
	/** @param {string} sub */
	const entries = (sub) => {
		try { return walk(join(out, sub)); } catch { return []; }
	};

	/** @param {string[]} rels @param {string} sub */
	const lines = (rels, sub) => rels
		.map((r) => `\t${JSON.stringify(r)}: import.meta.asset(${JSON.stringify(`./${sub}/${r}`)})`)
		.join(',\n');

	const client = entries('client');
	const prerendered = entries('prerendered');

	return [
		'// AUTO-GENERATED by adapter-bare. Lists every static asset so',
		'// bare-module-traverse picks them up when bundling.',
		'',
		'export const client = {',
		lines(client, 'client'),
		'};',
		'',
		'export const prerendered = {',
		lines(prerendered, 'prerendered'),
		'};',
		''
	].join('\n');
}
