import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'

const files = fileURLToPath(new URL('./files', import.meta.url).href)
const inject = fileURLToPath(new URL('./inject.js', import.meta.url).href)
const async_hooks_stub = fileURLToPath(new URL('./async-hooks-stub.js', import.meta.url).href)

/**
 * Vite plugin that automatically marks bare-* packages as SSR-external so
 * Vite doesn't try to bundle them during dev/preview. Add to vite.config.ts
 * alongside the sveltekit() plugin.
 * @returns {import('vite').Plugin}
 */
export function vitePlugin() {
  return {
    name: 'sveltekit-adapter-bare:externals',
    enforce: 'pre',
    config(cfg) {
      let pkg
      try {
        pkg = JSON.parse(readFileSync('package.json', 'utf8'))
      } catch {
        return
      }
      // Externalize all runtime dependencies so Vite's Node SSR process doesn't
      // try to bundle packages that use bare APIs or native addons.
      const entries = Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`])
      cfg.ssr = cfg.ssr ?? {}
      const existing = Array.isArray(cfg.ssr.external) ? cfg.ssr.external : []
      cfg.ssr.external = [...new Set([...existing, ...entries])]
    }
  }
}

/**
 * @typedef {{ width?: number, height?: number, inspectable?: boolean }} WindowOpts
 * @type {(opts?: { out?: string, window?: WindowOpts }) => import('@sveltejs/kit').Adapter}
 */
export default function (opts = {}) {
  const { out = 'build', window: win = {} } = opts
  const { width = 800, height = 600, inspectable = false } = win

  return {
    name: 'adapter-bare',

    async adapt(builder) {
      const tmp = builder.getBuildDirectory('adapter-bare')

      builder.rimraf(out)
      builder.rimraf(tmp)
      builder.mkdirp(tmp)

      builder.log.minor('Copying assets')
      builder.writeClient(`${out}/client${builder.config.kit.paths.base}`)
      builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`)

      builder.log.minor('Building server')
      builder.writeServer(tmp)

      writeFileSync(
        `${tmp}/manifest.js`,
        [
          `export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
          `export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
        ].join('\n\n')
      )

      // Rewrite node builtins to their bare counterparts, in both bare and
      // node: specifier form.
      //
      // This is the only chance to rewrite them. A builtin missing from the map
      // survives into the chunks verbatim, and by the time bare resolves it the
      // generated build/ is its own package — so the app's `imports` map, the
      // thing that made the specifier work under `vite dev`, is out of scope.
      // The failure then lands on whoever bundles the app rather than on
      // whoever built it, which is why this covers everything bare implements
      // and not just what one app happened to import.
      const bare_modules = {
        assert: 'bare-assert',
        buffer: 'bare-buffer',
        child_process: 'bare-subprocess',
        console: 'bare-console',
        crypto: 'bare-crypto',
        dgram: 'bare-dgram',
        dns: 'bare-dns',
        events: 'bare-events',
        fs: 'bare-fs',
        'fs/promises': 'bare-fs/promises',
        http: 'bare-http1',
        https: 'bare-https',
        inspector: 'bare-inspector',
        module: 'bare-module',
        net: 'bare-net',
        os: 'bare-os',
        path: 'bare-path',
        'path/posix': 'bare-path/posix',
        'path/win32': 'bare-path/win32',
        perf_hooks: 'bare-performance',
        process: 'bare-process',
        readline: 'bare-readline',
        repl: 'bare-repl',
        stream: 'bare-stream',
        'stream/promises': 'bare-stream/promises',
        'stream/web': 'bare-stream/web',
        string_decoder: 'bare-string-decoder',
        timers: 'bare-timers',
        'timers/promises': 'bare-timers/promises',
        tls: 'bare-tls',
        tty: 'bare-tty',
        url: 'bare-url',
        worker_threads: 'bare-worker',
        zlib: 'bare-zlib'
      }

      /** @type {Record<string, string>} */
      const bare_aliases = { 'node:async_hooks': async_hooks_stub }

      for (const [builtin, bare] of Object.entries(bare_modules)) {
        bare_aliases[builtin] = bare
        bare_aliases[`node:${builtin}`] = bare
      }

      const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

      // Keep all runtime deps external so bare-build resolves them at runtime
      // via bare-module-resolve, preserving the full transitive resolution chain.
      // Bundling a dep that transitively reaches a native addon causes bare-pack
      // to see require('.') inside a chunk — which it cannot satisfy.
      //
      // Everything we alias to goes in that set too. An app that imports `zlib`
      // rarely depends on bare-zlib by name, and bundling a bare shim is exactly
      // the case above — most of them reach an addon. External, they resolve at
      // runtime by walking up from build/ like any other dependency.
      const external = [
        ...new Set([
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.values(bare_modules).map((m) => m.split('/')[0])
        ])
      ].flatMap((d) => [d, `${d}/*`])

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
      })

      // SvelteKit uses `obfuscated_import("node:crypto")` as a dynamic
      // fallback when globalThis.crypto is absent. bare-build's static
      // traversal still finds the specifier and fails. Since we set
      // globalThis.crypto at startup the fallback is dead code — patch
      // it out of every generated chunk.
      patch_crypto(join(out, 'server'))

      // bare-module-traverse only picks up assets via STATIC import.meta.asset()
      // calls in source. Declaring globs in package.json is not enough. So we
      // enumerate every file under client/ + prerendered/ and emit an assets.js
      // module with one import.meta.asset() call per file, keyed by URL path.
      // bare-build sees each call and preserves the file; handler.js looks up
      // incoming request paths in the map and serves the resolved path.
      mkdirSync(join(out, 'prerendered'), { recursive: true })
      writeFileSync(join(out, 'assets.js'), generate_assets_module(out))

      builder.copy(files, out, {
        replace: {
          HANDLER: './handler.js',
          MANIFEST: './server/manifest.js',
          SERVER: './server/index.js',
          WINDOW_WIDTH: String(width),
          WINDOW_HEIGHT: String(height),
          WINDOW_INSPECTABLE: String(inspectable)
        }
      })
    },

    supports: {
      read: () => true
    }
  }
}

/**
 * Replace SvelteKit's lazy `node:crypto` dynamic import fallback in all
 * bundled JS files. The pattern only executes when `globalThis.crypto` is
 * absent; since we set it before anything else runs the branch is dead.
 * @param {string} dir
 */
function patch_crypto(dir) {
  // Matches: ... : (await obfuscated_import("node:crypto")).webcrypto
  const pattern = /\(await obfuscated_import\(["']node:crypto["']\)\)\.webcrypto/g
  const replacement = 'globalThis.crypto'

  for (const file of js_files(dir)) {
    const src = readFileSync(file, 'utf8')
    if (!pattern.test(src)) continue
    writeFileSync(file, src.replace(pattern, replacement))
  }
}

/** @param {string} dir @returns {string[]} */
function js_files(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...js_files(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * Walk a directory and return all file paths relative to `base`, using
 * forward slashes (URL-style) regardless of platform.
 * @param {string} base @param {string} dir @returns {string[]}
 */
function walk(base, dir = base) {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(base, full))
    else {
      out.push(
        full
          .slice(base.length + 1)
          .split(/[\\/]/)
          .join('/')
      )
    }
  }
  return out
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
    try {
      return walk(join(out, sub))
    } catch {
      return []
    }
  }

  /** @param {string[]} rels @param {string} sub */
  const lines = (rels, sub) =>
    rels
      .map((r) => `\t${JSON.stringify(r)}: import.meta.asset(${JSON.stringify(`./${sub}/${r}`)})`)
      .join(',\n')

  const client = entries('client')
  const prerendered = entries('prerendered')

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
  ].join('\n')
}
