// 网页端薄壳的后端：读状态、启停、上传题库。原生界面不用它；
// 没有 webServer 的宿主里 ctx.inject 不会触发，等于不存在。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readStatus } from './status.js'
import { readBankInfo, importBankFile } from './bankimport.js'

const MAX_UPLOAD = 20 * 1024 * 1024

const json = (body) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

function runCtl (dir, verb) {
  const ctl = path.join(dir, 'ctl.sh')
  if (!fs.existsSync(ctl)) return { ok: false, message: '脚本还没部署好' }
  const r = spawnSync('sh', [ctl, verb], { cwd: dir, timeout: 5000, encoding: 'utf8' })
  if (r.error) return { ok: false, message: String(r.error.message).slice(0, 80) }
  return { ok: r.status === 0, message: String(r.stdout || '').trim().split('\n').pop() || '' }
}

export function registerWeb (ctx, targetDir) {
  const runVersion = () => {
    try { return fs.readFileSync(path.join(targetDir, 'VERSION'), 'utf8').trim() } catch { return '-' }
  }

  const snapshot = (extra = {}) => {
    const st = readStatus(targetDir)
    const bank = readBankInfo(targetDir)
    return {
      ok: true,
      running: !!st.running,
      pid: st.pid || null,
      version: runVersion(),
      bank: bank && bank.count ? bank.count : 0,
      ...extra,
    }
  }

  ctx.inject(['webServer'], (ctx) => {
    // GET：状态 / 启停
    const ctlRoute = {
      kind: 'exact',
      path: '/plugin-exam/ctl',
      resource: (request) => {
        const url = new URL(request.url, 'http://localhost')
        const action = url.searchParams.get('action') || 'status'
        if (action === 'start' || action === 'stop') {
          const r = runCtl(targetDir, action)
          return json(snapshot({ action, message: r.message, ctlOk: r.ok }))
        }
        return json(snapshot({ action: 'status' }))
      },
    }

    // POST：上传题库文件（原始字节，文件名走 ?name=）
    const importRoute = {
      kind: 'exact',
      path: '/plugin-exam/import',
      handler: (req, res) => {
        const send = (code, body) => {
          const text = JSON.stringify(body)
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        }
        if (req.method !== 'POST') return send(405, { ok: false, message: 'POST only' })
        const url = new URL(req.url, 'http://localhost')
        const rawName = url.searchParams.get('name') || 'upload'
        const name = path.basename(decodeURIComponent(rawName)).replace(/[\\/:*?"<>|]/g, '_') || 'upload'
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > MAX_UPLOAD) { send(413, { ok: false, message: '文件超过 20 MB' }); req.destroy(); return }
          chunks.push(c)
        })
        req.on('end', () => {
          if (res.writableEnded) return
          const buf = Buffer.concat(chunks)
          if (!buf.length) return send(400, { ok: false, message: '空文件' })
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-bank-'))
          const tmpFile = path.join(tmpDir, name)
          try {
            fs.writeFileSync(tmpFile, buf)
            const r = importBankFile(targetDir, tmpFile)
            if (!r.ok) return send(200, { ok: false, message: String(r.msg || '解析失败').slice(0, 120), bank: (readBankInfo(targetDir) || {}).count || 0 })
            return send(200, { ok: true, file: name, imported: r.count, bank: r.count })
          } catch (e) {
            return send(500, { ok: false, message: String((e && e.message) || e).slice(0, 120) })
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
          }
        })
      },
    }

    try {
      const dispose = () => {
        const a = ctx.webServer.register(ctlRoute)
        const b = ctx.webServer.register(importRoute)
        return () => { a(); b() }
      }
      if (typeof ctx.effect === 'function') ctx.effect(dispose, 'exam-helper: web routes')
      else dispose()
    } catch (e) {
      console.warn('[exam-helper] 网页入口注册失败：' + (e && e.message))
    }
  })
}
