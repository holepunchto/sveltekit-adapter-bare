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

## Boot: `hooks.server.ts`

Boot the stack at module load, not on first request. Register async teardown on `sveltekit:close`. Never block the handle function.

```ts
// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit'
import { building } from '$app/environment'
import GhostDriveApp from '$lib/server/app.js'
import storage from 'bare-storage'
import path from 'path'

let app: GhostDriveApp | null = null

if (!building && !app) {
  const dir = path.join(storage.persistent(), 'ghost-drive')
  app = new GhostDriveApp({ dir })
  app
    .ready()
    .then(() => console.log('ready, key:', app!.key!.toString('hex')))
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
import type { LayoutServerLoad } from './$types'
import { loadSessions } from '$lib/server/loaders'

export const load: LayoutServerLoad = ({ locals, depends }) => {
  depends('app:layout')
  return { sessions: loadSessions(locals.app) } // Promise, not awaited
}
```

```svelte
<!-- +layout.svelte -->
{#await data.sessions}
  <Sidebar sessions={[]} />
{:then sessions}
  <Sidebar {sessions} />
{:catch}
  <Sidebar sessions={[]} />
{/await}
```

**Rules:**

- Never `await` in the return of a load function unless the data is needed for SSR rendering of the shell
- Never use `.then()` chains — use named `async` functions or `{#await}` instead
- Never use `Promise.resolve(x)` as a workaround — just use `x` or `{#await}` directly
- If you need a redirect based on async state, do it server-side in the load function (inside the async work), not client-side after page load

```ts
// Server-side redirect is clean:
export const load: PageServerLoad = async ({ locals, url }) => {
  if (url.searchParams.get('action')) return {};
  await locals.app.ready();
  const sessions = await locals.app.db.find(...).toArray();
  const last = sessions.sort(...)[0];
  if (last) throw redirect(303, `/drive/${last.id}`);
  return {};
};
```

## Loaders pattern: `$lib/server/loaders.ts`

All async server logic goes in `$lib/server/loaders.ts`. Route server files stay thin — they call loaders and return the results.

```ts
// src/lib/server/loaders.ts
import { error } from '@sveltejs/kit'
import type GhostDriveApp from './app.js'
import type DriveSession from './session.js'

export interface DriveInfo {
  id: string
  name: string
  peerCount: number
  isGuest: boolean
}
export interface DriveEntry {
  name: string
  isFolder: boolean
  cached: boolean
}
export interface PeerInfo {
  key: string
  short: string
  online: boolean
}

export async function getSession(app: GhostDriveApp, id: string): Promise<DriveSession> {
  await app.ready()
  const session = app.getSession(id)
  if (!session) throw error(404, 'Drive not found')
  return session
}

export async function loadDrive(app: GhostDriveApp, id: string): Promise<DriveInfo> {
  const session = await getSession(app, id)
  app.updateSession(id).catch(() => {})
  return {
    id: session.id,
    name: session.name,
    peerCount: session.peerCount,
    isGuest: session.isGuest
  }
}

export async function loadEntries(
  app: GhostDriveApp,
  id: string,
  dirPath: string
): Promise<DriveEntry[]> {
  const session = await getSession(app, id)
  const result: DriveEntry[] = []
  for await (const item of session.drive!.readdir(dirPath)) {
    // ...
  }
  return result
}
```

```ts
// src/routes/drive/[id]/+page.server.ts — thin coordinator
import { loadDrive, loadEntries } from '$lib/server/loaders'

export const load: PageServerLoad = ({ locals, params, url }) => {
  const dirPath = url.searchParams.get('path') || '/'
  return {
    path: dirPath,
    drive: loadDrive(locals.app, params.id), // Promise, streamed
    entries: loadEntries(locals.app, params.id, dirPath) // Promise, streamed
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

Prefer `{#await}` directly in templates. Only use `$effect` + local state when you need stale-while-revalidate (show old data while new data loads).

```svelte
<!-- Clean: inline await, no side effects -->
{#await data.drive then drive}
  <h1>{drive.name}</h1>
{/await}

<!-- Stale-while-revalidate: show cached while streaming -->
<script lang="ts">
  let { data }: PageProps = $props();
  let cachedEntries = $state<DriveEntry[] | null>(null);
  $effect(() => {
    data.entries.then((e) => (cachedEntries = e));
  });
</script>

{#await data.entries}
  {#if cachedEntries}
    <FileGrid entries={cachedEntries} />
  {:else}
    <!-- skeleton -->
  {/if}
{:then entries}
  <FileGrid {entries} />
{/await}
```

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

```js
import adapter from 'sveltekit-adapter-bare'
export default {
  kit: { adapter: adapter({ window: { width: 1200, height: 800, inspectable: false } }) }
}
```

### Vite plugin for auto-externalizing `bare-*` packages

```ts
// vite.config.ts
import { vitePlugin as bareExternals } from 'sveltekit-adapter-bare';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), bareExternals()],
  // vitePlugin auto-adds all bare-* packages to ssr.external
  // Manual additions for non-bare holepunch packages still needed:
  ssr: { external: ['distributed-drive', 'hyperdb', 'corestore', ...] }
});
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

- **Blocking in layout.server.ts** — `await locals.app.ready()` before returning causes a white screen. Stream instead.
- **`.then()` chains** — use named async functions or `{#await}`. `.then()` is hard to read and can't use `await` inside.
- **`Promise.resolve(x)` antipattern** — just use `x` directly or `{#await data.x}` in the template.
- **`(async () => {...})()`** — IIFEs for side effects (e.g. `goto()`) are not clean. Use server-side redirects or named handlers.
- **`$state` self-reference** — `let x = $state(x.map(...))` crashes SSR. Read from `data.x`.
- **Forgetting `cancel()` cleanup in SSE** — leaks a listener per reconnect. Track refs in outer `let`s.
- **Forgetting `setMaxListeners(0)` on EventHub** — floods stderr once a few SSE clients connect.
- **`swarm.join` to update announce state** — silently doubles up sessions. Use `discovery.refresh`.
- **Importing holepunch in `src/lib/`** (not `src/lib/server/`) — works in dev SSR, explodes in browser bundle.
- **Window close not killing the process on macOS** — hook `win._native?.on?.('will-close', shutdown)` directly.
- **Ambient declarations ignored for packages with shipped types** — if a package has `index.d.ts`, your `declare module 'pkg'` in ambient.d.ts is a no-op for that package. Cast with `as any` at call sites instead.

## Quick checklist for a new feature

1. Async data? → Named `async function` in `loaders.ts`, return its promise from load, `{#await}` in template.
2. UI update needed? → Emit on EventHub, subscribe in SSE endpoint, listen in `onMount`.
3. Mutation? → Form action + `use:enhance`, optimistic local state for toggles.
4. New long-lived resource? → `ReadyResource` subclass, opened in `_open()`, closed in `_close()`.
5. New swarm topic? → Keep the `discovery` handle, use `discovery.refresh()` to mutate.
6. Untyped package? → `ambient.d.ts` module declaration; if package ships own types, cast with `as any` at boundary.
