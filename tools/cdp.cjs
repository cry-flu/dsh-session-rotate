// 极简 CDP 客户端：连上 headless Chrome，提供 shot / click / eval / type
// 依赖：只用 Node 22+ 自带的 WebSocket（不需要 npm 的 ws，也不用 npm install）
// 用法：node tools/cdp.cjs <command> [args...]   （先自己起好 --remote-debugging-port 的 Chrome）
const fs = require('fs')
const http = require('http')

const DEFAULT_PORT = 9222
const WIDTH = 1200
const HEIGHT = 900

function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''
      res.on('data', (d) => (b += d))
      res.on('end', () => {
        try { resolve(JSON.parse(b)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

// 把 WHATWG WebSocket 包成 ws 风格（.on/.send/.close），调用方代码不用改
class MiniWs {
  constructor(url) {
    if (typeof WebSocket !== 'function') {
      throw new Error(`当前 Node ${process.version} 没有内置 WebSocket，请用 Node 22+`)
    }
    this.handlers = { message: [], open: [], error: [], close: [] }
    this.inner = new WebSocket(url)
    this.inner.addEventListener('message', (ev) => this.emit('message', ev.data))
    this.inner.addEventListener('open', () => this.emit('open'))
    this.inner.addEventListener('error', (ev) => {
      this.emit('error', (ev && ev.error) || new Error('websocket error'))
    })
    this.inner.addEventListener('close', (ev) => this.emit('close', ev))
  }
  on(name, fn) {
    ;(this.handlers[name] || (this.handlers[name] = [])).push(fn)
    return this
  }
  emit(name, arg) {
    for (const fn of this.handlers[name] || []) fn(arg)
  }
  send(text) {
    this.inner.send(text)
  }
  close() {
    try { this.inner.close() } catch {}
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 30000)
    })
  }
  async shot(file, clip) {
    const opts = { format: 'png', captureBeyondViewport: false }
    if (clip) opts.clip = clip
    const r = await this.send('Page.captureScreenshot', opts)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    await new Promise((r) => setTimeout(r, 60))
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 70))
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  async typeText(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

async function connect(port = DEFAULT_PORT) {
  const list = await httpJson(port, '/json/list')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target（Chrome 是不是没带 --remote-debugging-port 起来？）')
  const ws = new MiniWs(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('websocket open timeout')), 10000)
    ws.on('open', () => { clearTimeout(t); res() })
    ws.on('error', (e) => { clearTimeout(t); rej(e) })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  })
  return cdp
}

module.exports = { connect, Cdp, MiniWs, WIDTH, HEIGHT }

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2)
  ;(async () => {
    const cdp = await connect(Number(process.env.CDP_PORT || DEFAULT_PORT))
    try {
      if (cmd === 'shot') {
        const out = rest[0] || 'shot.png'
        await cdp.shot(out)
        console.log('saved', out, fs.statSync(out).size, 'bytes')
      } else if (cmd === 'eval') {
        console.log(JSON.stringify(await cdp.eval(rest.join(' ')), null, 2))
      } else if (cmd === 'click') {
        await cdp.click(Number(rest[0]), Number(rest[1]))
        console.log('clicked', rest[0], rest[1])
      } else if (cmd === 'type') {
        await cdp.typeText(rest.join(' '))
        console.log('typed')
      } else if (cmd === 'url') {
        const list = await httpJson(Number(process.env.CDP_PORT || DEFAULT_PORT), '/json/list')
        console.log(list.find((t) => t.type === 'page')?.url)
      } else {
        console.error('unknown command:', cmd)
        process.exitCode = 2
      }
    } finally {
      cdp.ws.close()
    }
  })().catch((e) => {
    console.error('FAIL:', e.message)
    process.exitCode = 1
  })
}
