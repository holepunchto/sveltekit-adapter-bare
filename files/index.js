import http from 'bare-http1'
import process from 'bare-process'
import { webcrypto } from 'bare-crypto'
import { Window, WebView } from 'bare-native'
import { command, flag } from 'paparam'
import { handler } from 'HANDLER'
import BackHandler from '#navigation'

globalThis.crypto = webcrypto

// Per-boot secret used to gate WebSocket upgrades. handler.js sets it as a
// HttpOnly cookie on the first response; the WebView sends it automatically
// on every subsequent request, including WS upgrades.
globalThis.__BARE_WS_TOKEN = webcrypto.randomUUID()

const cmd = command(
  'app',
  flag('--host <host>', 'Host to listen on').default('0.0.0.0'),
  flag('--port <port>', 'Port to listen on (0 = random, OS-assigned)').default('0'),
  flag('--width <px>', 'Window width').default('WINDOW_WIDTH'),
  flag('--height <px>', 'Window height').default('WINDOW_HEIGHT'),
  flag('--inspectable', 'Enable WebView inspector')
)

cmd.parse(process.argv.slice(2), { run: false })

const host = cmd.flags.host ?? '0.0.0.0'
const requested_port = Number(cmd.flags.port ?? 0)
const width = Number(cmd.flags.width ?? WINDOW_WIDTH)
const height = Number(cmd.flags.height ?? WINDOW_HEIGHT)
const inspectable = cmd.flags.inspectable === true || WINDOW_INSPECTABLE

const server = http.createServer((req, res) => {
  handler(req, res, () => {
    res.statusCode = 404
    res.end('Not Found')
  })
})

server.on('upgrade', (req, socket) => {
  if (parse_cookies(req.headers['cookie'] ?? '')['_bwt'] !== globalThis.__BARE_WS_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
  }
})

/** @param {string} header @returns {Record<string, string>} */
function parse_cookies(header) {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

let win = null
let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  // Await any cleanup handlers registered by the app (e.g. in hooks.server.ts)
  const handlers = process.listeners('sveltekit:close')
  if (handlers.length) {
    await Promise.all(handlers.map((fn) => Promise.resolve().then(fn)))
  }

  try {
    server.close()
  } catch {}
  // Closing the native window handle lets the AppKit/GTK event loop exit cleanly
  try {
    win?._native?.close()
  } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(requested_port, host, () => {
  // `port: 0` asks the OS for a free port; read the real one back so the
  // WebView connects to the actual listening port.
  const { port } = server.address()
  console.log(`Listening on http://${host}:${port}`)

  win = new Window(width, height)
  const webView = new WebView()
  win.content(webView)
  webView.loadURL(`http://localhost:${port}`)
  if (inspectable) webView.inspectable(true)

  // AppKitWindow (macOS) emits 'will-close' when the user clicks the red X.
  // Without this the process keeps running after the window is gone.
  win._native?.on?.('will-close', shutdown)

  BackHandler.on('back', () => {
    webView.loadURL(
      'javascript:(function(){var e=new CustomEvent("bare:back",{cancelable:true,bubbles:true});window.dispatchEvent(e);if(!e.defaultPrevented)history.back()})()'
    )
  })
})

export { server }
