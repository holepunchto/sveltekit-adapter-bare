import Request from 'bare-fetch/request'
import Response from 'bare-fetch/response'
import Headers from 'bare-fetch/headers'
import { ReadableStream as BareReadableStream } from 'bare-stream/web'
import { TextEncoder, TextDecoder } from 'bare-encoding'
import { webcrypto as crypto } from 'bare-crypto'

// Claude:
// bare-stream/web's ReadableStream awaits the user-provided `start()` before
// releasing any enqueued chunks to readers — see its `_open` implementation,
// which binds `start.call(controller)` as the streamx open-gate. This breaks
// the WHATWG semantics that SvelteKit relies on for streamed load promises:
// SvelteKit enqueues the initial data chunk, then awaits further chunks in
// the same `start()` body, expecting the first chunk to be consumable while
// `start()` is still running. Under bare, the whole stream is held until
// every promise resolves, and clients see the page navigation hang.
//
// Shim: intercept the `start` callback so we hand bare-stream a synchronous
// one (which resolves `_open` immediately) while running the user's real
// `start` in the background — its enqueues still land on the underlying
// streamx Readable, but reads are no longer gated on its completion.
class ReadableStream extends BareReadableStream {
  constructor(source, strategy) {
    if (source && typeof source.start === 'function') {
      const user_start = source.start
      source = {
        ...source,
        start(controller) {
          Promise.resolve()
            .then(() => user_start.call(this, controller))
            .catch((err) => {
              try {
                controller.error(err)
              } catch {}
            })
        }
      }
    }
    super(source, strategy)
  }
}

export { Request, Response, Headers, ReadableStream, TextEncoder, TextDecoder, crypto }
