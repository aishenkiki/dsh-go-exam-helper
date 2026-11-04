// 直连 DSH 手机桥接（abstract unix socket），用 MCP JSON-RPC 读屏 / 发通知。
import net from 'node:net'
import fs from 'node:fs'

const BRIDGE = '/var/lib/dsh-app/phone/bridge.json'

// 每次连接都重读桥接配置：socket 名每次引擎启动都会变，缓存住就连不上了。
function readCfg () {
  return JSON.parse(fs.readFileSync(BRIDGE, 'utf8'))
}

export function connect () {
  return new Promise((resolve, reject) => {
    let cfg
    try {
      cfg = readCfg()
    } catch (e) {
      reject(e)
      return
    }
    const sock = net.connect({ path: '\0' + cfg.abstract })
    let buf = ''
    let nextId = 1
    const pending = new Map()
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      sock.write(JSON.stringify({ dshPhone: 1, token: cfg.token }) + '\n')
      resolve(api)
    })
    sock.on('error', reject)
    sock.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('closed'))
      pending.clear()
    })
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const p = pending.get(msg.id)
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
      }
    })
    // 每次调用都有超时：桥接半死时不让整轮循环卡住；超时同时把 pending 清掉，避免长跑内存缓慢增长。
    const TIMEOUT = 12000
    const call = (method, params, timeout = TIMEOUT) => new Promise((res, rej) => {
      if (sock.destroyed) { rej(new Error('closed')); return }
      const id = nextId++
      const timer = setTimeout(() => {
        if (pending.delete(id)) rej(new Error(method + ' 超时'))
      }, timeout)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v) },
        reject: (e) => { clearTimeout(timer); rej(e) },
      })
      try {
        sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        pending.delete(id)
        rej(e)
      }
    })
    const api = {
      socket: sock,
      request: call,
      async init () {
        const r = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'exam-helper', version: '0.1.0' } })
        sock.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
        return r
      },
      async tools () {
        const r = await call('tools/list', {})
        return r.tools.map((t) => t.name)
      },
      async callTool (name, args = {}) {
        const r = await call('tools/call', { name, arguments: args })
        const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        const images = (r.content || []).filter((c) => c.type === 'image')
        return { text, images, raw: r }
      },
      close () { sock.end() },
    }
  })
}
