---
name: svelte-bare-app
description: This skill should be used when building, modifying, or debugging a SvelteKit application running on the Bare runtime with the Holepunch / pear stack (Hypercore, Hyperswarm, Hyperbee, HyperDB, Corestore, DistributedDrive, Localdrive, Hyperdrive). Triggers on requests mentioning "svelte bare app", "SvelteKit on bare", "P2P svelte", "sveltekit-adapter-bare", "SSE in SvelteKit", "hyperswarm + svelte", "live stats stream", "ghost drive", or any task that involves wiring SvelteKit server endpoints to a long-lived P2P stack. Covers hooks.server.ts boot, $lib/server boundaries, TypeScript for untyped holepunch packages, SvelteKit streaming with {#await}, form actions with use:enhance, and the gotchas that bite specifically in this combination (Bare's missing Node globals, Hyperswarm session semantics, Svelte 5 runes, white screen on boot).
version: 2.0.0
---

# SvelteKit + Bare app

A SvelteKit application whose server side runs inside the Bare runtime and owns a long-lived P2P stack (Corestore + Hyperswarm + HyperDB / DistributedDrive). The server is a singleton; the browser only ever talks to SvelteKit endpoints.

If you only remember five things:

1. **Never block rendering.** Every load function must return immediately — put async work in a `Promise` value so SvelteKit can stream. Use `{#await}` in templates, never `.then()` chains.
2. **The server stack is a long-lived singleton, not request-scoped.** Boot it in `hooks.server.ts`; park it on `event.locals`.
3. **All load logic lives in `$lib/server/loaders.ts`.** Route server files are thin coordinators that import from loaders and return streamed promises.
4. **TypeScript for the untyped holepunch world.** Use `src/lib/server/ambient.d.ts` for bare-\* and holepunch packages that ship no types. Use `import type` for circular deps between server modules.
5. **`sveltekit:close` is your cleanup hook.** Register teardown in `process.on('sveltekit:close', ...)` inside `hooks.server.ts`.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Bare process                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  SvelteKit (sveltekit-adapter-bare)                        │ │
│  │                                                            │ │
│  │  hooks.server.ts ──► GhostDriveApp ──► event.locals.app   │ │
│  │                                                            │ │
│  │  $lib/server/loaders.ts  ◄── routes/**/+page.server.ts    │ │
│  │  $lib/server/app.ts                                        │ │
│  │  $lib/server/session.ts                                    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Long-lived stack                                          │ │
│  │  Corestore ── Hyperswarm ── HyperDB ── DistributedDrive   │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Project scaffolding

### `package.json`

Every Bare SvelteKit app needs these exact groups. Missing any of the bare-\* runtime deps causes a silent build failure or a crash at startup.

**Runtime dependencies** (bundled into the app):

```json
"dependencies": {
  "bare-crypto":  "^1.13.6",
  "bare-fetch":   "^3.0.1",
  "bare-http1":   "^4.5.6",
  "bare-module":  "^6.2.0",
  "bare-native":  "^0.1.2",
  "bare-process": "^4.4.1"
}
```

**Dev dependencies**:

```json
"devDependencies": {
  "bare-build":            "^0.5.5",
  "sveltekit-adapter-bare": "...",
  "@sveltejs/kit":         "...",
  "svelte":                "...",
  "vite":                  "..."
}
```

**Build scripts** (substitute `<app>`, `<AppName>`, `com.<org>.<app>`):

```json
"scripts": {
  "dev":          "vite dev",
  "build":        "vite build",
  "make:darwin":  "bare-build --out out/<app>-darwin-arm64 --host darwin-arm64 --icon <app>.png --name <AppName> --runtime bare-native/runtime build/index.js",
  "make:android": "bare-build --out out/android-arm64 --resources resources/android --host android-arm64 --manifest manifest.xml --identifier com.<org>.<app> --name <AppName> --runtime bare-native/runtime build/index.js"
}
```

> **Icon caveat**: `--icon <app>.png` requires a real PNG in the project root. This file cannot be auto-generated — ask the user to provide it before wiring up `make:darwin`. Do not synthesise a placeholder and proceed silently.

### `svelte.config.js`

Two settings beyond the adapter are required and non-obvious:

1. **`runes` scoped** — enforce runes mode only outside `node_modules`; some Holepunch deps don't use runes and will break with `runes: true` globally.
2. **`csrf: { checkOrigin: false }`** — form actions are broken without this inside Bare (the request origin never matches the server origin).

```js
import adapter from 'sveltekit-adapter-bare'

const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
  },
  kit: {
    adapter: adapter({ window: { width: 1200, height: 800 } }),
    csrf: { checkOrigin: false }
  }
}

export default config
```

### `manifest.xml` (Android only)

Required by `make:android`. Place it in the project root. Minimum viable manifest — substitute `package`, `android:label`, and version fields:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<manifest
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:versionCode="1"
    android:versionName="1.0"
    package="com.yourorg.yourapp"
>
  <uses-sdk android:minSdkVersion="33" android:targetSdkVersion="36" />
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
  <application
        android:label="YourApp"
        android:usesCleartextTraffic="true"
        android:icon="@mipmap/ic_launcher"
        android:enableOnBackInvokedCallback="true"
    >
    <activity
            android:name="to.holepunch.bare.Activity"
            android:exported="true"
            android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize"
            android:theme="@android:style/Theme.NoTitleBar.Fullscreen"
        >
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
```

## Boot: `hooks.server.ts`

Boot the stack at module load, not on first request. Register async teardown on `sveltekit:close`. Never block the handle function.

```ts
// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit'
import { building } from '$app/environment'
import GhostDriveApp from '$lib/server/app.js'
import storage from 'bare-storage'
import path from 'path'
import process from 'process' // required: Bare does not inject process as a global

let app: any = null // 'any' avoids circular-type issues; type via app.d.ts

if (!building && !app) {
  const dir = path.join(storage.persistent(), 'ghost-drive')
  app = new GhostDriveApp({ dir })
  app
    .ready()
    .then(() => console.log('ready, key:', app.key.toString('hex')))
    .catch((err: Error) => console.error('boot failed:', err))

  process.on('sveltekit:close', async () => {
    try {
      await app?.close()
    } catch {}
  })
}

export const handle: Handle = ({ event, resolve }) => {
  event.locals.app = app
  return resolve(event)
}
```

`app.ready()` is fire-and-forget — the handle never awaits it. Individual load functions call `await app.ready()` lazily, inside the promise they stream back. This means the first request returns HTML immediately while the P2P stack warms up in the background.

Wire the type in `src/app.d.ts`:

```ts
import type GhostDriveApp from '$lib/server/app'
declare global {
  namespace App {
    interface Locals {
      app: import('$lib/server/app').default | null
    }
  }
}
export {}
```

## Never block rendering — SvelteKit streaming

**The white-screen bug**: if `+layout.server.ts` or `+page.server.ts` does `await locals.app.ready()` before returning, SvelteKit cannot send the initial HTML until that resolves. On cold boot this takes seconds. Use streaming instead.

**Pattern**: return a `Promise` as a data property. SvelteKit sends the shell HTML immediately, then streams the resolved value.

```ts
// src/routes/+layout.server.ts
import type { LayoutServerLoad } from '$types'
import { loadSessions } from '$lib/server/loaders'

// Sessions are needed for the sidebar (SSR shell), so await is correct here.
// app.listSessions() is O(1) after app.ready(), so no meaningful delay.
export const load: LayoutServerLoad = async ({ locals, depends }) => {
  depends('app:layout') // lets callers invalidate('app:layout') to re-run this
  return { sessions: await loadSessions(locals.app) }
}
```

```svelte
<!-- +layout.svelte — sessions already resolved, no {#await} needed -->
<Sidebar sessions={data.sessions} />
```

**When to await vs stream:**

- **Await** in layout/page loads when the data is needed to render the HTML shell (sidebar list, page title, route guards). After `app.ready()` these reads are local and fast.
- **Stream** (return a Promise) for data that requires P2P network access or heavy I/O — drive entries, peer lists, file previews. Use `{#await}` in the template.

**Rules:**

- Never `await` a long P2P operation before returning from a load function — stream it
- Never use `.then()` chains in templates — use `{#await}` or named async functions
- **Never use `throw redirect()` anywhere** — server-side redirects break Android. Always navigate with client-side `goto()`

### Targeted invalidation: `depends()` + `goto({ invalidate })`

Use `depends('app:layout')` in the layout load, then pass `invalidate` to `goto()` to refresh only that load when navigating. This is cleaner than calling `invalidate()` then `goto()` separately.

```ts
// +layout.server.ts — declare the dependency
depends('app:layout')
```

```svelte
<!-- settings/+page.svelte — after deleting a session -->
<form use:enhance={() => async () => {
  goto('/', { invalidate: ['app:layout'] })
}}>
```

`goto()` alone does NOT re-run the layout load when the URL root hasn't changed. Always pass `invalidate` (or call `invalidate('app:layout')` before `goto()`) when mutations should update the sidebar or other layout data.

## No server-side redirects — always use `goto()`

`throw redirect(303, ...)` in load functions or form actions breaks Android navigation. Every redirect must be client-side.

**Load function that needs to redirect**: return a streamed Promise, let the client `goto()` when it resolves.

```ts
// +page.server.ts
export const load: PageServerLoad = ({ locals, url }) => {
  if (url.searchParams.get('action')) return {};
  return { autoOpen: findLastSession(locals.app) }; // Promise<string | null>
};

async function findLastSession(app: GhostDriveApp | null): Promise<string | null> {
  if (!app) return null;
  await app.ready();
  const all = await app.db!.find(...).toArray() as any[];
  const last = all.sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))[0];
  return (last && app.sessions.has(last.id)) ? last.id : null;
}
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import { goto } from '$app/navigation';
  let { data } = $props();

  async function autoNavigate(p: Promise<string | null> | undefined) {
    if (!p) return;
    const id = await p;
    if (id) goto(`/drive/${id}`);
  }

  $effect(() => { autoNavigate(data.autoOpen); });
</script>
```

**Form actions that need to redirect**: return `{ redirect: '/path' }` from the action, call `goto()` in the enhance callback.

```ts
// +page.server.ts
export const actions: Actions = {
  create: async ({ locals, request }) => {
    const session = await locals.app.createSession({ name })
    return { redirect: `/drive/${session.id}` } // NOT throw redirect
  }
}
```

```svelte
<!-- +page.svelte -->
<form method="POST" action="?/create"
  use:enhance={() => async ({ result }) => {
    if (result.type === 'success' && result.data?.redirect) {
      goto(result.data.redirect as string);
    }
  }}>
```

**Form actions that only need to refresh data**: return `{}` and let the default `use:enhance` call `invalidateAll()`.

```ts
// server — no redirect needed
return {}
```

```svelte
<!-- client — bare use:enhance calls invalidateAll() on success -->
<form method="POST" action="?/addDrive" use:enhance>
```

**Form actions that navigate away and need to refresh layout data**: return `{}` from server, use `goto()` with the `invalidate` option. This is cleaner than calling `invalidate()` then `goto()` separately.

```ts
// server
deleteSession: async ({ locals, params }) => {
  await locals.app.removeSession(params.id)
  return {}
}
```

```svelte
<form method="POST" action="?/deleteSession"
  use:enhance={() => async () => {
    goto('/', { invalidate: ['app:layout'] })
  }}>
```

`goto()` alone does NOT re-run the layout load when the root URL segment hasn't changed. The `invalidate` option triggers the declared `depends('app:layout')` dependency before navigation completes.

## Loaders pattern: `$lib/server/loaders.ts`

All async server logic goes in `$lib/server/loaders.ts`. Route server files stay thin — they call loaders and return the results.

```ts
// src/lib/server/loaders.ts
import { error } from '@sveltejs/kit'
import type GhostDriveApp from './app.js'
import type DriveSession from './session.js'

export interface DriveEntry {
  name: string
  isFolder: boolean
  cached: boolean
  size: number | null
}

// --- Parallelizing inside an async iterator ---
// Fire all per-item promises immediately without awaiting inside the loop.
// For a 100-file directory, this collapses ~200 sequential P2P round-trips
// into one parallel batch.
async function fetchEntries(app: GhostDriveApp, id: string, dirPath: string): Promise<DriveEntry[]> {
  const session = await getSession(app, id)
  const seen = new Set<string>()
  const pending: Promise<DriveEntry>[] = []

  async function resolveEntry(name: string): Promise<DriveEntry> {
    const fullPath = dirPath === '/' ? '/' + name : `${dirPath}/${name}`
    // ... two parallel lookups per entry: entry() + cache.entry()
    return { name, isFolder, cached, size }
  }

  for await (const item of session.drive!.readdir(dirPath)) {
    const name = typeof item === 'string' ? item : (item as any).key || (item as any).name
    if (!name || name.startsWith('.') || seen.has(name)) continue
    seen.add(name)
    pending.push(resolveEntry(name)) // fire, don't await
  }

  const entries = await Promise.all(pending) // resolve all concurrently
  return entries.sort(...)
}
```

### Stale-while-revalidate (SWR) loader

Return cached data immediately, then stream fresh data as a second `fresh` promise. The client renders instantly with stale data and updates cleanly when the background fetch completes.

```ts
// loaders.ts — SWR cache
const REVALIDATE_AFTER = 15_000

interface CacheEntry {
  entries: DriveEntry[]
  ts: number
  pending?: Promise<DriveEntry[]> // dedup concurrent revalidations
}

const entriesCache = new Map<string, CacheEntry>()

export function loadEntries(
  app: GhostDriveApp,
  id: string,
  dirPath: string
): { entries: Promise<DriveEntry[]>; fresh: Promise<DriveEntry[]> | null } {
  const cacheKey = `${id}:${dirPath}`
  const hit = entriesCache.get(cacheKey)

  if (!hit) {
    // First load — wait for real data
    const p = fetchEntries(app, id, dirPath).then((entries) => {
      entriesCache.set(cacheKey, { entries, ts: Date.now() })
      return entries
    })
    return { entries: p, fresh: null }
  }

  if (Date.now() - hit.ts < REVALIDATE_AFTER) {
    return { entries: Promise.resolve(hit.entries), fresh: null }
  }

  // Stale — return cached immediately, revalidate in background
  if (!hit.pending) {
    hit.pending = fetchEntries(app, id, dirPath)
      .then((entries) => {
        entriesCache.set(cacheKey, { entries, ts: Date.now() })
        return entries
      })
      .finally(() => {
        const c = entriesCache.get(cacheKey)
        if (c) delete c.pending
      })
  }
  return { entries: Promise.resolve(hit.entries), fresh: hit.pending }
}
```

```ts
// +page.server.ts — spread both values
export const load: PageServerLoad = ({ locals, params, url }) => {
  const dirPath = (url.searchParams.get('path') || '/').replaceAll('+', ' ')
  const { entries, fresh } = loadEntries(locals.app, params.id, dirPath)
  return {
    path: dirPath,
    drive: loadDrive(locals.app, params.id), // Promise, streamed
    entries, // Promise — instant if cached
    fresh // Promise | null — streams fresh data after stale render
  }
}
```

## TypeScript for untyped holepunch packages

Most holepunch packages ship no TypeScript types. Use `src/lib/server/ambient.d.ts` for ambient module declarations.

```ts
// src/lib/server/ambient.d.ts
declare module 'ready-resource' {
  export default class ReadyResource {
    readonly opened: boolean
    readonly closed: boolean
    ready(): Promise<void>
    close(): Promise<void>
    emit(event: string, ...args: unknown[]): boolean
    on(event: string, listener: (...args: unknown[]) => void): this
    protected _open(): Promise<void>
    protected _close(): Promise<void>
  }
}

declare module 'corestore' {
  export default class Corestore {
    constructor(path: string)
    ready(): Promise<void>
    close(): Promise<void>
    createKeyPair(name: string): Promise<{ publicKey: Buffer; secretKey: Buffer }>
    replicate(conn: unknown): unknown
    session(): Corestore
  }
}

declare module 'localdrive' {
  export default class Localdrive {
    constructor(path: string)
    ready(): Promise<void>
    close(): Promise<void>
    get(path: string, opts?: object): Promise<any>
    list(prefix?: string, opts?: object): AsyncIterable<any>
    readdir(prefix: string): AsyncIterable<string>
    entry(path: string): Promise<any>
    batch(): { del(key: string): Promise<void>; flush(): Promise<void> }
    mirror(dest: unknown, opts?: object): { done(): Promise<void> }
  }
}

declare module 'bare-storage' {
  const storage: { persistent(): string; ephemeral(): string }
  export default storage
}
// ... etc for hyperswarm, hyperdb, hyperbee, b4a, sodium-native
```

**Key rules:**

- If a package ships its own `index.d.ts` (e.g. `distributed-drive`, `hyperdrive`), your ambient declaration for it is IGNORED — TypeScript uses the package's types. Cast with `as any` at call sites where the shipped types are incomplete:
  ```ts
  this.drive!.register(local as any) // Drive interface mismatch
  this.drive!.mirror(this.cache as any, opts) // Drive interface mismatch
  ;(session.drive as any).getPeerKeys() // method exists in impl, not in types
  ```
- Use `import type` for circular dependencies between server modules:
  ```ts
  // session.ts
  import type GhostDriveApp from './app.js' // type-only, breaks circular dep
  ```
- Use `!` non-null assertions when TypeScript can't prove a field is set after `ready()`:
  ```ts
  this.app.db!.insert(...)  // db is non-null after _open()
  this.drive!.register(...)  // drive is non-null after _open()
  ```
- Exclude generated/vendor JS from type checking in `tsconfig.json`:
  ```json
  { "exclude": ["spec"] }
  ```

## `$lib/server` discipline

Anything that imports holepunch or `bare-*` MUST live under `src/lib/server/`. SvelteKit guarantees `$lib/server/*` cannot be imported from client code.

Structure:

- `$lib/server/app.ts` — main app class extending `ReadyResource`
- `$lib/server/session.ts` — per-session logic
- `$lib/server/loaders.ts` — all typed async helpers for load functions
- `$lib/server/ambient.d.ts` — type declarations for untyped packages

## Svelte 5 runes in templates — async patterns

Prefer `{#await}` directly in templates. Only use `$effect` + local state when you need stale-while-revalidate (show old data while new data loads, then update cleanly when fresh arrives).

```svelte
<!-- Clean: inline await, no side effects -->
{#await data.drive then drive}
  <h1>{drive.name}</h1>
{/await}

<!-- Full SWR pattern:
     data.entries  — resolves immediately from cache (stale ok)
     data.fresh    — Promise<Entry[]> | null — streams fresh data when ready
     cachedEntries — reactive $state so the grid updates when fresh arrives   -->
<script lang="ts">
  let { data }: PageProps = $props();
  let cachedEntries = $state<DriveEntry[] | null>(null);

  $effect(() => {
    let cancelled = false
    ;(async () => {
      cachedEntries = await data.entries
      if (data.fresh && !cancelled) {
        cachedEntries = await data.fresh // swaps in cleanly when background fetch lands
      }
    })()
    return () => { cancelled = true } // cancel stale update if user navigates away
  })
</script>

{#await data.entries}
  {#if cachedEntries !== null}
    <FileGrid entries={cachedEntries} /> <!-- previous dir while loading -->
  {:else}
    <!-- skeleton (true first load only) -->
  {/if}
{:then entries}
  <!-- Use cachedEntries (reactive) not entries (local let) so fresh update flows through -->
  <FileGrid entries={cachedEntries ?? entries} />
{/await}
```

The `cancelled` flag prevents a resolved `data.fresh` from writing to `cachedEntries` after the user has already navigated away and `data` has changed. Without it you get a stale write racing the new navigation.

**Pitfall: self-reference in `$state`**

```svelte
<!-- WRONG — crashes: "Cannot access 'repos' before initialization" -->
let repos = $state(data.repos.map((r) => ({ ...r })));

<!-- RIGHT — read from data, sync via $effect -->
let repos: typeof data.repos = $state([]);
$effect(() => { repos = data.repos.map((r) => ({ ...r })); });
```

## Adapter: `sveltekit-adapter-bare`

### Setup in `svelte.config.js`

See [Project scaffolding → svelte.config.js](#project-scaffolding) for the full required config. The short version — `csrf` and scoped `runes` are both required:

```js
import adapter from 'sveltekit-adapter-bare'

const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
  },
  kit: {
    adapter: adapter({ window: { width: 1200, height: 800 } }),
    csrf: { checkOrigin: false }
  }
}

export default config
```

### Vite plugin for auto-externalizing `bare-*` packages

```ts
// vite.config.ts
import tailwindcss from '@tailwindcss/vite'
import { sveltekit } from '@sveltejs/kit/vite'
import { vitePlugin as bareExternals } from 'sveltekit-adapter-bare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), bareExternals()]
  // No manual ssr.external needed.
  // bareExternals() reads package.json and externalizes ALL runtime
  // dependencies — bare-*, holepunch packages, native addons, everything.
  // Just make sure every native dep is in "dependencies" (not devDependencies).
})
```

### Android back navigation

The adapter intercepts the Android back gesture/button automatically and calls `history.back()` in the WebView. No app code needed.

To override, listen for the cancelable `bare:back` DOM event:

```svelte
<script>
  import { onMount } from 'svelte'
  onMount(() => {
    const handler = (e) => {
      e.preventDefault()
      // custom logic
    }
    window.addEventListener('bare:back', handler)
    return () => window.removeEventListener('bare:back', handler)
  })
</script>
```

### Shutdown: Ctrl-C, window close, and `sveltekit:close`

The adapter emits `sveltekit:close` on shutdown. Register teardown there:

```ts
process.on('sveltekit:close', async () => {
  await app?.close()
})
```

**Window close on macOS**: `AppKitWindow` emits `'will-close'` but the `NativeWindow` wrapper in `bare-native/darwin.js` does NOT forward it. Hook directly on `win._native`:

```js
// Inside adapter files/index.js after creating the window:
win._native?.on?.('will-close', shutdown)
```

Without this, clicking the window X on macOS leaves the process running (the Bare event loop has no reason to exit).

**The shutdown function pattern:**

```js
let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const handlers = process.listeners('sveltekit:close')
  await Promise.all(handlers.map((fn) => Promise.resolve().then(fn)))
  try {
    server.close()
  } catch {}
  try {
    win?._native?.close()
  } catch {} // exits AppKit event loop
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

### Set-Cookie header fix

The Bare HTTP handler must use `getSetCookie()` to avoid flattening multiple `Set-Cookie` headers:

```js
const headers = {}
for (const [key, value] of response.headers) {
  if (key.toLowerCase() === 'set-cookie') continue
  headers[key] = value
}
if (typeof response.headers.getSetCookie === 'function') {
  const cookies = response.headers.getSetCookie()
  if (cookies.length === 1) headers['set-cookie'] = cookies[0]
  else if (cookies.length > 1) headers['set-cookie'] = cookies
}
res.writeHead(response.status, headers)
```

## SSE: shared EventHub, not per-connection polling

One EventEmitter wired to swarm events once; each SSE connection subscribes to hub events.

```ts
// src/lib/server/events.ts
import { EventEmitter } from 'node:events'
class EventHub extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(0)
  } // unbounded: one per SSE client
  attach(app: GhostDriveApp) {
    /* wire swarm events once */
  }
}
const g = globalThis as { __eventHub?: EventHub }
export const events: EventHub = g.__eventHub ?? (g.__eventHub = new EventHub())
```

```ts
// src/routes/api/events/+server.ts
export const GET: RequestHandler = async () => {
  let onStats: (() => void) | null = null
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      onStats = () => send('stats', events.getStats())
      events.on('stats', onStats)
      send('stats', events.getStats()) // immediate snapshot
    },
    cancel() {
      if (onStats) events.off('stats', onStats) // MUST clean up or leak
    }
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no'
    }
  })
}
```

## Form actions: `use:enhance` + optimistic UI

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import { tick } from 'svelte';
  let { data }: PageProps = $props();
  let enabled = $state(data.enabled);
  let form: HTMLFormElement;

  async function toggle() {
    enabled = !enabled;
    await tick(); // let hidden input observe new value
    form.requestSubmit();
  }
</script>

<form bind:this={form} method="POST" action="?/setEnabled"
  use:enhance={() => async ({ update }) => { await update({ reset: false }); }}>
  <input type="hidden" name="value" value={enabled} />
</form>
<button onclick={toggle}>Toggle</button>
```

## Hyperswarm gotcha: `join` vs `refresh`

`swarm.join(topic, opts)` called twice adds a SECOND session — it does NOT update the first.

```js
// WRONG — adds a session, leaves old one alive
swarm.join(topic, { server: false, client: true })

// RIGHT — mutates the existing session
discovery.refresh({ server: false, client: true })
await discovery.flushed()
```

Track the `discovery` handle returned by the original `join()`.

## HyperDB gotchas

- **`db.find()` returns an async iterator.** Always `for await`, never assume sync.
- **Compact-encoded schemas cannot be expanded after the fact.** Think about field additions before writing your schema.
- **Empty blobs round-trip as `null`.** Use `obj.data || Buffer.alloc(0)` when reading blob fields.

## Bare runtime specifics

- **`Buffer` is NOT a global in all contexts.** Use `b4a` for cross-runtime byte ops.
- **`process.versions.bare`** distinguishes Bare from Node.
- **`bare-storage`** for persistent/ephemeral paths: `storage.persistent()` returns a writable path that survives app restarts.
- **No `setImmediate` semantics guaranteed.** Use `queueMicrotask` / `Promise.resolve().then(...)`.

## Common pitfalls

- **Missing bare-\* runtime deps** — `bare-crypto`, `bare-fetch`, `bare-http1`, `bare-module`, `bare-native`, `bare-process` must all be in `dependencies`. Omitting any causes a silent build failure or startup crash.
- **`csrf: { checkOrigin: false }` missing from `svelte.config.js`** — form actions silently fail inside Bare because the request origin never matches the server. Required, not optional.
- **`runes: true` globally in `compilerOptions`** — breaks any Holepunch dep that isn't in runes mode. Use the scoped form: `runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true`.
- **`manifest.xml` missing for Android builds** — `make:android` fails immediately. Create the file in the project root (see scaffolding section for the template).
- **Android swipe-back gesture not working** — add `android:enableOnBackInvokedCallback="true"` to the `<application>` tag and set `minSdkVersion="33"`. Without it, `OnBackInvokedDispatcher` only catches button presses, not edge swipes.
- **`--icon` flag without a real PNG** — `make:darwin` requires a PNG in the project root. Do not auto-generate a placeholder; ask the user to provide it.
- **`throw redirect()` in any server file** — breaks Android navigation. Return `{ redirect: '/path' }` and call `goto()` in the enhance callback instead.
- **Blocking in layout.server.ts** — `await locals.app.ready()` before returning causes a white screen. Stream instead.
- **`.then()` chains** — use named async functions or `{#await}`. `.then()` is hard to read and can't use `await` inside.
- **`Promise.resolve(x)` antipattern** — just use `x` directly or `{#await data.x}` in the template.
- **`(async () => {...})()`** — IIFEs for side effects (e.g. `goto()`) are not clean. Use server-side redirects or named handlers.
- **`$state` self-reference** — `let x = $state(x.map(...))` crashes SSR. Read from `data.x`.
- **`+` in query params on Android** — Android WebView decodes `+` as a space in query strings. `url.searchParams.get('path')` may return `/my+folder` instead of `/my folder`. Always call `.replaceAll('+', ' ')` on path/file params read from the URL: `url.searchParams.get('path')?.replaceAll('+', ' ') ?? '/'`.
- **Stale `$effect` writing after navigation** — an async `$effect` that awaits a slow promise (e.g. `data.fresh`) can resolve after the user has navigated away. Always use a `cancelled` flag: set it in the cleanup (`return () => { cancelled = true }`) and check before every state write.
- **`goto()` not refreshing layout data** — `goto('/some-path')` does not re-run the root layout load if the root URL segment is unchanged. Pass `{ invalidate: ['app:layout'] }` to `goto()`, or call `invalidate('app:layout')` before navigating.
- **Child component never calling `onchange` with initial value** — if a child receives an initial value as a prop but only calls `onchange` on SSE/event updates, the parent's reactive state stays at its default (e.g. `0` peer count → wrong banner shown). Use `onMount(() => onchange?.(initial))` in the child to sync the parent immediately on mount.
- **Forgetting `cancel()` cleanup in SSE** — leaks a listener per reconnect. Track refs in outer `let`s.
- **Forgetting `setMaxListeners(0)` on EventHub** — floods stderr once a few SSE clients connect.
- **`swarm.join` to update announce state** — silently doubles up sessions. Use `discovery.refresh`.
- **Importing holepunch in `src/lib/`** (not `src/lib/server/`) — works in dev SSR, explodes in browser bundle.
- **Window close not killing the process on macOS** — hook `win._native?.on?.('will-close', shutdown)` directly.
- **Ambient declarations ignored for packages with shipped types** — if a package has `index.d.ts`, your `declare module 'pkg'` in ambient.d.ts is a no-op for that package. Cast with `as any` at call sites instead.

## Quick checklist for a new feature

1. Async P2P data? → Named `async function` in `loaders.ts`, return its promise (not awaited) from load, `{#await}` in template.
2. Many items to resolve per-entry? → Fire promises inside the `for await` loop without awaiting; collect in array; `Promise.all()` after.
3. Repeat navigation fast? → Add a TTL cache in `loaders.ts`; return `{ entries, fresh }` for SWR — instant stale render + background refresh.
4. Mutation that changes sidebar/layout? → `goto(path, { invalidate: ['app:layout'] })` — `goto()` alone won't re-run the layout load.
5. UI update needed? → Emit on EventHub, subscribe in SSE endpoint, listen in `onMount`.
6. Form action? → `use:enhance`, return `{}` from server, `goto()` on client. Never `throw redirect()`.
7. New long-lived resource? → `ReadyResource` subclass, opened in `_open()`, closed in `_close()`.
8. New swarm topic? → Keep the `discovery` handle, use `discovery.refresh()` to mutate.
9. Untyped package? → `ambient.d.ts` module declaration; if package ships own types, cast with `as any` at boundary.
10. Path/file query param? → `.replaceAll('+', ' ')` — Android WebView decodes `+` as space.
