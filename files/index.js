import http from 'bare-http1'
import process from 'bare-process'
import { webcrypto } from 'bare-crypto'
import { Window, WebView } from 'bare-native'
import { command, flag } from 'paparam'
import { handler } from 'HANDLER'

globalThis.crypto = webcrypto

const cmd = command(
  'app',
  flag('--host <host>', 'Host to listen on').default('0.0.0.0'),
  flag('--port <port>', 'Port to listen on (0 = random, OS-assigned)').default('0'),
  flag('--width <px>', 'Window width').default('800'),
  flag('--height <px>', 'Window height').default('600'),
  flag('--inspectable', 'Enable WebView inspector')
)

cmd.parse(process.argv.slice(2), { run: false })

const host = cmd.flags.host ?? '0.0.0.0'
const requested_port = Number(cmd.flags.port ?? 0)
const width = Number(cmd.flags.width ?? 800)
const height = Number(cmd.flags.height ?? 600)
const inspectable = cmd.flags.inspectable === true

const server = http.createServer((req, res) => {
  handler(req, res, () => {
    res.statusCode = 404
    res.end('Not Found')
  })
})

function shutdown() {
  try {
    server.close()
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

  const window = new Window(width, height)
  const webView = new WebView()
  window.content(webView)
  webView.loadURL(`http://localhost:${port}`)
  if (inspectable) webView.inspectable(true)
})

export { server }
