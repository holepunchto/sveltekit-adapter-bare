// Stub for node:async_hooks. AsyncLocalStorage is used by SvelteKit to thread
// per-request context through load functions and hooks. This simple version
// works correctly for serial requests (the local p2p case). Concurrent async
// requests would see each other's context — not a concern here.

export class AsyncLocalStorage {
  #store

  run(store, fn, ...args) {
    const prev = this.#store
    this.#store = store
    try {
      return fn(...args)
    } finally {
      this.#store = prev
    }
  }

  getStore() {
    return this.#store
  }
  enterWith(store) {
    this.#store = store
  }
  exit(fn, ...args) {
    const prev = this.#store
    this.#store = undefined
    try {
      return fn(...args)
    } finally {
      this.#store = prev
    }
  }
  disable() {}
  enable() {}
}

export class AsyncResource {
  constructor(type) {
    this.type = type
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args)
  }
  static bind(fn) {
    return fn
  }
  bind(fn) {
    return fn
  }
}

export function createHook() {
  return { enable() {}, disable() {} }
}
export function executionAsyncId() {
  return 0
}
export function triggerAsyncId() {
  return 0
}
