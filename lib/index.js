// 答题助手插件：负责「部署脚本 + 启停 + 看状态」，答题逻辑本身仍在 watch.mjs 里。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureDeployed } from './deploy.js'
import { readStatus } from './status.js'

export const name = 'local-exam-helper'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAYLOAD_DIR = path.join(PLUGIN_DIR, 'payload')
const TARGET_DIR = process.env.DSH_EXAM_DIR || path.join(os.homedir(), '.dsh', 'dsh-go', 'exam-helper')

let deployResult = { action: 'skipped' }

function deploy () {
  try {
    deployResult = ensureDeployed({
      payloadDir: PAYLOAD_DIR,
      targetDir: TARGET_DIR,
      warn: (msg) => console.warn(msg),
    })
  } catch (e) {
    deployResult = { action: 'error', error: String(e && e.message) }
    console.warn('[exam-helper] 部署失败：' + (e && e.message))
  }
}

function callCtl (verb, event) {
  const en = String((event && event.locale) || '').startsWith('en')
  const ctl = path.join(TARGET_DIR, 'ctl.sh')
  if (!fs.existsSync(ctl)) {
    return { toast: en ? 'Script is not deployed yet' : '脚本还没部署好，重启引擎试试' }
  }
  const r = spawnSync('sh', [ctl, verb], { cwd: TARGET_DIR, timeout: 5000, encoding: 'utf8' })
  if (r.error) {
    const msg = r.error.code === 'ETIMEDOUT' ? (en ? 'Timed out' : '超时了，稍后再看面板') : String(r.error.message).slice(0, 30)
    return { toast: msg }
  }
  const out = String(r.stdout || '').trim().split('\n').pop() || ''
  return { toast: out.slice(0, 40) || (en ? 'Done' : '好了') }
}

export function apply (ctx) {
  // 只有 DSH Go 宿主才部署和注册界面；装在别的 DSH 里什么都不做。
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['dshGo'], (ctx) => {
    deploy()

    // 界面 registering 失败不能连累整个插件：任何一处抛错都只记一笔，其余照常注册。
    const guard = (what, fn) => {
      try {
        return fn()
      } catch (e) {
        try { fs.appendFileSync(path.join(TARGET_DIR, 'plugin-err.log'), `${new Date().toISOString()} ${what}: ${e && e.message}\n`) } catch {}
        console.warn(`[exam-helper] ${what} 注册失败：` + (e && e.message))
      }
    }
    guard('strip', () => {
    // 输入框上方只留一条状态条（两个胶囊并排会被权限条挤掉一半），点一下开面板。
    ctx.dshGo.strip('exam-status', (scope, emit, caps) => {
      const en = String((caps && caps.locale) || '').startsWith('en')
      const tick = () => {
        const s = readStatus(TARGET_DIR)
        const num = (s.recent[0] && /第\s*(\d+)\s*题/.exec(s.recent[0].title) || [])[1]
        if (!fs.existsSync(path.join(TARGET_DIR, 'ctl.sh'))) {
          emit({ text: en ? 'Exam · not deployed' : '答题助手 · 未部署', icon: 'warning', tone: 'warn' })
          return
        }
        if (!s.running) {
          emit({ text: en ? 'Exam · idle' : '答题助手 · 未开始', icon: 'book', tone: 'info' })
          return
        }
        emit({
          text: en ? `Watching · Q${num || '-'}` : `监考中 · ${num ? '第 ' + num + ' 题' : '等待切题'}`,
          icon: 'running',
          tone: s.error && Date.now() - Date.parse(s.error.at) < 120000 ? 'warn' : 'good',
        })
      }
      tick()
      const timer = setInterval(tick, 4000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    })

    })
    guard('panel', () => ctx.dshGo.panel('exam', {
      view: (scope, caps) => {
        const en = String((caps && caps.locale) || '').startsWith('en')
        return {
          v: 1,
          type: 'stack',
          title: en ? 'Exam helper' : '答题助手',
          children: [
            {
              type: 'metric',
              label: en ? 'Status' : '运行状态',
              value: { $: 'data.state' },
              tone: { $: 'data.tone' },
              caption: { $: 'data.caption' },
            },
            { type: 'text', text: { $: 'data.error' }, tone: 'muted' },
            { type: 'list', items: { $: 'data.recent' } },
            {
              type: 'actions',
              items: [
                { label: en ? 'Start' : '开始', action: 'start', style: 'primary' },
                { label: en ? 'Stop' : '停止', action: 'stop' },
              ],
            },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const en = String((caps && caps.locale) || '').startsWith('en')
        const tick = () => {
          const s = readStatus(TARGET_DIR)
          const recent = s.recent.length > 0
            ? s.recent
            : [{ title: en ? 'No answers yet' : '还没有作答记录', subtitle: '' }]
          emit({
            state: s.running ? (en ? 'Running' : '运行中') : (en ? 'Stopped' : '未运行'),
            tone: s.running ? 'good' : 'info',
            caption: s.pid ? 'pid ' + s.pid : (en ? 'Tap start to watch the screen' : '点「开始」后开始盯屏'),
            error: s.error
              ? (en ? `Last error ${s.error.at}: ${s.error.text}` : `最近一次异常 ${s.error.at}：${s.error.text}`)
              : '',
            recent,
          })
        }
        tick()
        const timer = setInterval(tick, 5000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      },
      actions: {
        start: (scope, event) => callCtl('start', event),
        stop: (scope, event) => callCtl('stop', event),
      },
    }))
  })
}
