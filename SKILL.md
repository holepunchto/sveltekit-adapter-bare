---
name: svelte-bare-app
description: This skill should be used when building, modifying, or debugging a SvelteKit application running on the Bare runtime with the Holepunch / pear stack (Hypercore, Hyperswarm, Hyperbee, HyperDB, Corestore, BlindPeering). Triggers on requests mentioning "svelte bare app", "SvelteKit on bare", "P2P svelte", "gear", "SSE in SvelteKit", "hyperswarm + svelte", "live stats stream", or any task that involves wiring SvelteKit server endpoints to a long-lived P2P stack. Covers hooks.server.ts boot, $lib/server boundaries, globalThis singletons, the shared EventHub SSE pattern, form actions with use:enhance, and the gotchas that bite specifically in this combination (Bare's missing Node globals, Hyperswarm session semantics, Svelte 5 runes self-reference traps).
version: 1.0.0
---

# Svelte + Bare app

A SvelteKit app whose server side runs inside the Bare runtime and owns a long-lived P2P stack (Corestore + Hyperswarm + HyperDB). The reference implementation is **Gear**, a P2P GitHub replacement wrapping `gip-transport` / `gip-remote`.

This skill captures the patterns and pitfalls that are specific to that combination — they aren't in the SvelteKit docs because they're about wiring SvelteKit to a stateful peer-to-peer backend, and they aren't in the Holepunch docs because they're about doing it from inside SvelteKit.

If you only remember three things:

1. **The server stack is a long-lived singleton, not request-scoped.** Stash it on `globalThis` and warm it from `hooks.server.ts`.
2. **One SSE stream + one shared EventEmitter hub beats N polling timers.** Fan out from real swarm/core events.
3. **Hyperswarm `swarm.join()` adds a NEW session each call.** To mutate announce/lookup state for an already-joined topic, call `discovery.refresh()` on the existing session.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Bare process                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  SvelteKit (Node-style adapter)                            │ │
│  │                                                            │ │
│  │  hooks.server.ts ──► getDB() ──► globalThis.__db           │ │
│  │       │                                                    │ │
│  │       └──► events.attach(db) ──► globalThis.__eventHub     │ │
│  │                                                            │ │
│  │  $lib/server/*  ◄── routes/**/+page.server.ts              │ │
│  │  $lib/server/*  ◄── routes/**/+server.ts (incl. SSE)       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Long-lived stack                                          │ │
│  │  Corestore ── Hyperswarm ── BlindPeering                   │ │
│  │      │            │                                        │ │
│  │      └─ HyperDB / Hyperbee per repo                        │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The browser never talks to Hyperswarm. It talks to SvelteKit endpoints (form actions, `+server.ts`, SSE). Server endpoints talk to the singletons.

## Boot: `hooks.server.ts`

The whole P2P stack must be alive before the first request hits. Warm it in `hooks.server.ts` and stash the promise. Every `handle` awaits it and parks `db` on `event.locals`.

```ts
// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';
import { getDB } from '$lib/server/gip';
import { events } from '$lib/server/events';

// Warm the singletons at module load — not on first request. The
// promise resolves once and every handle awaits the same one.
const dbPromise = getDB().then(async (db) => {
  events.attach(db);
  return db;
});

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.db = await dbPromise;
  return resolve(event);
};
```

`event.locals.db` needs to be typed in `src/app.d.ts`:

```ts
declare global {
  namespace App {
    interface Locals {
      db: import('$lib/server/gip').GipDB;
    }
  }
}
export {};
```

## `$lib/server` discipline

Anything that imports `corestore`, `hyperswarm`, `hyperdb`, or anything else with a Node/Bare dependency MUST live under `src/lib/server/`. SvelteKit guarantees `$lib/server/*` cannot be imported from client code — a client import is a build-time error, not a runtime explosion.

Rule of thumb:

- `$lib/server/gip.ts` — db singleton + `getDB()` getter
- `$lib/server/events.ts` — EventHub
- `$lib/server/types.ts` — types that reference server modules
- `$lib/types.ts` — pure shapes that the client also consumes

Never put a `b4a`, `compact-encoding`, or `corestore` import in `src/lib/`. The Vite bundler will try to ship it to the browser.

## Singletons on `globalThis`

SvelteKit's dev server hot-reloads modules. A naive `let db = null; export async function getDB() { ... }` re-runs on every reload and you end up with N corestores fighting for the same data dir. Pin to `globalThis`:

```ts
// src/lib/server/gip.ts
const g = globalThis as unknown as { __gipDB?: Promise<GipDB> };

export function getDB(): Promise<GipDB> {
  if (g.__gipDB) return g.__gipDB;
  g.__gipDB = (async () => {
    const store = new Corestore('./data/gear')
    const swarm = new Hyperswarm({ /* ... */ })
    // ...
    return new GipDB(store, swarm /* ... */)
  })();
  return g.__gipDB;
}
```

Same pattern for `events` (the EventHub) and any other long-lived resource.

## SSE: shared EventHub, not per-connection polling

The naive shape — every SSE connection opens its own `setInterval` to read swarm state — N×M-poll-explodes the moment you have a few clients × a few repos. The right shape:

- **One** EventEmitter (the hub) wires to swarm/core events ONCE.
- Each SSE connection just subscribes to hub events.
- Per-resource attach is **lazy** — don't wire 100 cores until something cares.

### The hub

```ts
// src/lib/server/events.ts
import { EventEmitter } from 'node:events';

class EventHub extends EventEmitter {
  private peerKeys = new Set<string>();
  private attachedCores = new WeakSet<object>();
  private repoState = new Map<string, RepoStats>();
  private db: GipDB | null = null;

  constructor() {
    super();
    // Each SSE client adds listeners — default cap of 10 trips
    // MaxListenersExceededWarning instantly. Unbounded is fine here:
    // listeners are bounded by client count, not data.
    this.setMaxListeners(0);
  }

  attach(db: GipDB) {
    if (this.db) return; // idempotent
    this.db = db;
    const swarm = (db as any).swarm;
    swarm.on('connection', (conn) => {
      const key = b4a.toString(conn.remotePublicKey, 'hex');
      this.peerKeys.add(key);
      this.emit('stats');
      conn.on('close', () => {
        this.peerKeys.delete(key);
        this.emit('stats');
      });
    });
  }

  async ensureRepoAttached(db: GipDB, name: string) {
    if (this.repoState.has(name)) return;
    const entry = await db.getCore(name, { server: false, client: false });
    if (!entry) return;
    const core = entry.core;
    this.repoState.set(name, { length: core.length, peers: core.peers.length });

    if (this.attachedCores.has(core)) return;
    this.attachedCores.add(core);

    const recompute = () => {
      this.repoState.set(name, { length: core.length, peers: core.peers.length });
      this.emit(`repo:${name}`);
      this.emit('repo', { name, ...this.repoState.get(name)! });
    };

    let lastLength = core.length;
    core.on('append', () => {
      const from = lastLength;
      lastLength = core.length;
      this.emit(`append:${name}`, { from, to: lastLength, added: lastLength - from });
      recompute();
    });
    core.on('peer-add', recompute);
    core.on('peer-remove', recompute);
  }
}

const g = globalThis as unknown as { __eventHub?: EventHub };
export const events: EventHub = g.__eventHub ?? (g.__eventHub = new EventHub());
```

### The SSE endpoint

```ts
// src/routes/api/events/+server.ts
import type { RequestHandler } from './$types';
import { events } from '$lib/server/events';

export const GET: RequestHandler = async ({ locals }) => {
  await events.attachAll(locals.db); // lazy-wire every repo

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let onStats: (() => void) | null = null;
  let onRepo: ((p: any) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send('stats', events.getStats()); // immediate snapshot

      onStats = () => send('stats', events.getStats());
      events.on('stats', onStats);

      onRepo = (payload) => send('repo', payload);
      events.on('repo', onRepo);

      // Keep proxies/load-balancers from killing the idle connection.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 30_000);
    },
    cancel() {
      if (onStats) events.off('stats', onStats);
      if (onRepo) events.off('repo', onRepo);
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
};
```

Critical bits:

- **`cancel()` MUST clean up listeners.** Otherwise the hub accumulates dead listeners on every reconnect. Track the listener references in outer-scope `let`s so `cancel()` can find them.
- **Heartbeat every ~30s.** SvelteKit's adapter, nginx, Cloudflare, etc. all kill idle TCP connections at varying intervals.
- **Send an immediate snapshot in `start`** so the UI doesn't render stale SSR data while waiting for the first real event.
- **`x-accel-buffering: no`** disables proxy buffering that would otherwise hold the stream until it fills a buffer.
- **One global stream over many.** Browsers cap HTTP/1.1 connections to ~6 per host. A single `/api/events` carrying generic `repo` events for all repos beats one connection per row.

### The client

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // PITFALL: don't write `let repos = $state(repos.map(...))` — it
  // self-references and crashes SSR with "Cannot access 'repos' before
  // initialization". Read from `data.repos`, then re-sync via $effect.
  let repos: typeof data.repos = $state(data.repos.map((r) => ({ ...r })));
  $effect(() => {
    repos = data.repos.map((r) => ({ ...r }));
  });

  onMount(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('repo', (e) => {
      const payload = JSON.parse((e as MessageEvent).data);
      const idx = repos.findIndex((r) => r.name === payload.name);
      if (idx === -1) return;
      repos[idx] = { ...repos[idx], length: payload.length, peers: payload.peers };
    });
    return () => es.close();
  });
</script>
```

## Form actions: `use:enhance` + optimistic UI

For toggles and small mutations, run the action through `use:enhance` and optimistically flip local state. Use a hidden form + `requestSubmit()` for switches that don't have a visible submit button:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import { tick } from 'svelte';

  let { data, form }: PageProps = $props();
  let seedReadOnly = $state(data.seedReadOnly);
  let seedForm: HTMLFormElement;

  async function toggleSeedReadOnly() {
    seedReadOnly = !seedReadOnly; // optimistic
    await tick();                 // let the hidden input observe the new value
    seedForm.requestSubmit();     // fire form action
  }
</script>

<form
  bind:this={seedForm}
  method="POST"
  action="?/setSeedReadOnly"
  use:enhance={() => async ({ update }) => { await update({ reset: false }); }}
>
  <input type="hidden" name="value" value={seedReadOnly} />
</form>

<button onclick={toggleSeedReadOnly}>
  Seeding read-only mirrors: {seedReadOnly ? 'on' : 'off'}
</button>
```

Server side:

```ts
// src/routes/settings/+page.server.ts
export const actions = {
  setSeedReadOnly: async ({ request, locals }) => {
    const data = await request.formData();
    const value = data.get('value') === 'true';
    await locals.db.setSeedReadOnly(value);
    return { ok: true };
  }
} satisfies Actions;

export const load = async ({ locals }) => ({
  seedReadOnly: await locals.db.getSeedReadOnly()
});
```

## Hyperswarm gotcha: `join` vs `refresh`

This one bit Gear hard. Calling `swarm.join(topic, opts)` a second time does NOT mutate the existing discovery — it adds a SECOND `PeerDiscoverySession` for the same topic. Your old `{ server: true }` session keeps announcing while the new `{ server: false }` session quietly does nothing useful. To toggle announce/lookup on a topic you've already joined:

```js
// WRONG — adds a session, leaves old one alive
swarm.join(topic, { server: false, client: true })

// RIGHT — mutates the existing session in place
discovery.refresh({ server: false, client: true })
if (announceNow) await discovery.flushed()
```

Track the `discovery` handle returned by the original `join()` call. Use `discovery.isServer` (not `_server`) to read state.

## HyperDB / Hyperbee gotchas

- **Compact-encoded structs cannot be expanded after the fact.** If a schema field needs to change, you need a migration path — don't just edit `schema/hyperdb/index.js`.
- **Empty blobs round-trip as `null`.** Always `obj.data || Buffer.alloc(0)` when reading blob bytes you intend to write to disk.
- **`db.find()` returns an async iterator.** Always `for await`, never assume sync.
- **Branch records that hold a denormalized "everything reachable" set must MERGE on update**, not overwrite. A thin pack push only contains new objects — overwriting drops history. (This was the "I cloned and lost a commit" bug in `gip-remote`.)

## File-deletion sync on commits

If you index files keyed by `(branch, path)`, a commit that removes a file leaves a ghost row unless you reconcile. Diff the new tree against existing rows BEFORE inserting:

```js
const newPaths = new Set(files.map((f) => f.path))
const existing = db.find('@gip/files', { branch: refName })
for await (const file of existing) {
  if (!newPaths.has(file.path)) {
    await db.delete('@gip/files', { branch: refName, path: file.path })
  }
}
// then insert/upsert the current tree
```

## Bare runtime specifics

- **`Buffer` is NOT a global.** Use `b4a` (`require('b4a')`) for cross-runtime byte ops, or import `Buffer` explicitly.
- **`process.versions.bare`** distinguishes Bare from Node — useful when a shared module needs to branch.
- **No `setImmediate` semantics guaranteed.** Stick to `queueMicrotask` / `Promise.resolve().then(...)` for next-tick work.
- **Holepunch packages aren't typed.** Cast through `unknown` at the boundary, then expose typed wrappers from `$lib/server/`. Don't sprinkle `any`.

## Common pitfalls (compounded list)

- **`let x = $state(x.map(...))` crashes SSR.** Read from `data.x` (or rename the input). The error reads "Cannot access 'x' before initialization" and is hard to spot in a diff if you got here via `replace_all`.
- **`replace_all` across `+page.svelte` is dangerous.** It happily corrupts variable declarations into self-references. Prefer scoped `Edit` calls.
- **Forgetting to clean SSE listeners in `cancel()`** leaks an EventEmitter listener per reconnect. Within minutes the hub is firing into thousands of dead handlers.
- **Forgetting `setMaxListeners(0)` on the hub** floods stderr with `MaxListenersExceededWarning` once a handful of clients connect.
- **Polling on every SSE connection** means a 100-repo / 50-tab fleet does 5000 redundant reads per tick. Use the hub.
- **Calling `swarm.join` to "update" announce state** silently doubles up sessions. Use `discovery.refresh`.
- **Putting a corestore-importing file in `src/lib/`** — it'll silently work in dev (SSR) and explode at build time (or in the browser bundle). Move to `$lib/server/`.
- **Restarting the server during dev without `globalThis` singletons** leaks corestore handles to the data dir. Pin singletons.

## Testing notes (`brittle` + `hyperdht/testnet`)

The reference test pattern for any P2P feature in this stack:

```js
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')

test('feature', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const r1 = await createRemote(t, { name: 'r1', bootstrap })
  // ... push, fetch, replicate
  const r2 = await createRemote(t, { link: r1.url, bootstrap })
  t.is(r1.core.length, r2.core.length)
})
```

Always pass `t.teardown` to the testnet — otherwise the DHT keeps running and the next test inherits its peers.

## Quick checklist when scaffolding a new feature

1. Does it touch the P2P stack? → goes in `$lib/server/`.
2. Does it need to push live updates to the UI? → emit on the hub, subscribe in the SSE endpoint, listen in `onMount`.
3. Does it mutate persistent state? → form action + `use:enhance`, optimistic local state if it's a toggle.
4. Does it open a new long-lived resource? → singleton-on-`globalThis`, attach lazily.
5. Does it add a new swarm topic or change announce state? → keep the `discovery` handle and use `refresh()`.
6. Does it add a new schema field? → think about back-compat first; compact-encoded structs don't expand cleanly.
