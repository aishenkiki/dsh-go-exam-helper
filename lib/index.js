// 答题助手插件：部署脚本 + 启停 + 自检 + 导入题库，答题逻辑仍在 watch.mjs 里。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureDeployed } from './deploy.js'
import { readStatus } from './status.js'
import { scanCandidates, importBankFile, readBankInfo, selfCheck, formatSize, formatTime } from './bankimport.js'

export const name = 'dsh-go-exam-helper'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAYLOAD_DIR = path.join(PLUGIN_DIR, 'payload')
// 版本号：插件包版本 + 运行目录里实际部署的版本（两者可能不一致，正好用来排查"改了没生效"）
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version } catch { return '?' }
})()
const runVersion = () => {
  try { return fs.readFileSync(path.join(TARGET_DIR, 'VERSION'), 'utf8').trim() } catch { return '-' }
}

const TARGET_DIR = process.env.DSH_EXAM_DIR || path.join(os.homedir(), '.dsh', 'dsh-go', 'exam-helper')

let lastImport = null

function deploy () {
  try {
    ensureDeployed({ payloadDir: PAYLOAD_DIR, targetDir: TARGET_DIR, warn: (msg) => console.warn(msg) })
  } catch (e) {
    console.warn('[exam-helper] 部署失败：' + (e && e.message))
  }
}

function callCtl (verb, event) {
  const en = String((event && event.locale) || '').startsWith('en')
  // 每次启停前先同步一次脚本：换了新版本后，点「停止」再「开始」就能用上新逻辑，不必重开 App。
  if (verb === 'start') deploy()
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
  return { toast: out.slice(0, 40) || (en ? 'Done' : '好了'), refresh: true }
}

// 手动指定路径导入（表单提交上来的值）
function doImportPath (event) {
  const en = String((event && event.locale) || '').startsWith('en')
  const raw = event && event.value
  let p = ''
  if (typeof raw === 'string') p = raw
  else if (raw && typeof raw === 'object') {
    p = raw.manualPath || raw.path || Object.values(raw).find((v) => typeof v === 'string') || ''
  }
  p = String(p || '').trim().replace(/^file:\/\//, '')
  if (!p) return { toast: en ? 'Paste a file path first' : '请先填文件路径', refresh: true }
  if (!fs.existsSync(p)) return { toast: (en ? 'Not found: ' : '找不到这个文件：') + p.slice(0, 40), refresh: true }
  const r = importBankFile(TARGET_DIR, p)
  lastImport = { ok: r.ok, msg: r.msg, file: path.basename(p) }
  if (!r.ok) return { toast: (en ? 'Import failed: ' : '导入失败：') + String(r.msg).slice(0, 60), refresh: true }
  return { toast: (en ? 'Imported ' : '已导入 ') + r.count + (en ? ' questions' : ' 题'), refresh: true }
}

// 导入题库：只认点选的文件；没指定就提示去列表里点
function doImport (event) {
  const en = String((event && event.locale) || '').startsWith('en')
  const want = event && event.value && (event.value.file || event.value.value)
  if (!want) return { toast: en ? 'Tap a file in the list below' : '请点下面列表里的文件名导入', refresh: true }
  const pick = { file: want }
  const r = importBankFile(TARGET_DIR, pick.file)
  lastImport = { ok: r.ok, msg: r.msg, file: path.basename(pick.file) }
  if (!r.ok) return { toast: (en ? 'Import failed: ' : '导入失败：') + String(r.msg).slice(0, 60) }
  return { toast: (en ? 'Imported ' : '已导入 ') + r.count + (en ? ' questions' : ' 题') }
}

export function apply (ctx) {
  // 只有 DSH Go 宿主才部署和注册界面；装在别的 DSH 里什么都不做。
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['dshGo'], (ctx) => {
    deploy()

    // 界面注册失败不能连累整个插件：任何一处抛错只记一笔，其余照常注册。
    const guard = (what, fn) => {
      try {
        return fn()
      } catch (e) {
        try { fs.appendFileSync(path.join(TARGET_DIR, 'plugin-err.log'), `${new Date().toISOString()} ${what}: ${e && e.message}\n`) } catch {}
        console.warn(`[exam-helper] ${what} 注册失败：` + (e && e.message))
      }
    }

    // 输入框上方一条状态条：点一下开面板。
    guard('strip', () => {
      ctx.dshGo.strip('exam-strip', (scope, emit, caps) => {
        const en = String((caps && caps.locale) || '').startsWith('en')
        const stamp = () => {
          const d = new Date()
          return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        }
        const tick = () => {
          try {
            const s = readStatus(TARGET_DIR)
            const num = (s.recent[0] && /第\s*(\d+)\s*题/.exec(s.recent[0].title) || [])[1]
            if (!fs.existsSync(path.join(TARGET_DIR, 'ctl.sh'))) {
              emit({ text: (en ? 'Exam · not deployed' : '答题助手 · 未部署') + ' · ' + stamp(), icon: 'warning', tone: 'warn' })
              return
            }
            if (!s.running) {
              const bank = readBankInfo(TARGET_DIR)
              const tail = bank && bank.count ? '' : (en ? ' · no bank' : ' · 无题库')
              emit({ text: (en ? 'Exam · idle' : '答题助手 · 未开始') + tail + ' · v' + PKG_VERSION + ' · ' + stamp(), icon: 'book', tone: 'info' })
              return
            }
            emit({
              text: (en ? `Watching · Q${num || '-'}` : `监考中 · ${num ? '第 ' + num + ' 题' : '等待切题'}`) + ' · v' + PKG_VERSION + ' · ' + stamp(),
              icon: 'running',
              tone: s.error && Date.now() - Date.parse(s.error.at) < 120000 ? 'warn' : 'good',
            })
          } catch (e) {
            emit({ text: (en ? 'Exam · status error' : '答题助手 · 状态读取失败') + ' · ' + stamp(), icon: 'warning', tone: 'warn' })
          }
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
        const t = (zh, eng) => (en ? eng : zh)
        return {
          v: 2,
          type: 'stack',
          title: t('答题助手', 'Exam helper'),
          children: [
            { type: 'metric', label: t('当前状态', 'Status'), value: { $: 'data.state' }, tone: { $: 'data.tone' }, caption: { $: 'data.caption' } },
            { type: 'steps', items: { $: 'data.steps' } },
            { type: 'callout', text: { $: 'data.tip' }, tone: { $: 'data.tipTone' } },
            { type: 'callout', text: { $: 'data.faultHint' }, tone: 'warn' },
            {
              type: 'actions',
              items: [
                { label: t('开始', 'Start'), action: 'start', style: 'primary', icon: 'play' },
                { label: t('停止', 'Stop'), action: 'stop', icon: 'stop' },
                { label: t('重新扫描题库', 'Rescan'), action: 'scan', icon: 'refresh' },
              ],
            },
            { type: 'text', text: t('题库', 'Answer bank') },
            { type: 'text', text: { $: 'data.bankLine' }, tone: 'muted' },
            { type: 'callout', text: { $: 'data.scanHint' }, tone: { $: 'data.scanHintTone' } },
            { type: 'list', items: { $: 'data.candidates' } },
            {
              type: 'form',
              label: t('手动指定文件', 'Pick a file by path'),
              children: [
                { type: 'textField', label: t('文件完整路径（可长按粘贴）', 'Full path'), bind: 'data.manualPath', placeholder: '/sdcard/Download/题库.csv' },
              ],
              submit: 'importPath',
              submitLabel: t('导入这个文件', 'Import this file'),
            },
            {
              type: 'collapsible',
              label: t('题库格式建议（点开看例子）', 'Bank format (tap to expand)'),
              expanded: false,
              children: [
                { type: 'text', text: t('支持 csv / tsv / xlsx / json / 纯文本；有表头最好。表头认这些名字：题干、答案A…答案F、正确答案。', 'csv/tsv/xlsx/json/txt. Header names: 题干, 答案A…F, 正确答案.') },
                {
                  type: 'codeBlock',
                  language: 'csv',
                  code: '序号,题干,答案A,答案B,答案C,答案D,正确答案\n1,结售汇业务授权原则上多久一定?,每季度一次,每半年一次,每年一次,每两年一次,C',
                },
              ],
            },
            { type: 'text', text: { $: 'data.checksSummary' }, tone: 'muted' },
            { type: 'keyValue', items: { $: 'data.checks' } },
            { type: 'text', text: t(`版本 ${PKG_VERSION}（运行 ${runVersion()}）`, `Version ${PKG_VERSION} (runtime ${runVersion()})`), tone: 'muted' },
            { type: 'text', text: t('最近作答', 'Recent answers') },
            { type: 'list', items: { $: 'data.recent' } },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const en = String((caps && caps.locale) || '').startsWith('en')
        const t = (zh, eng) => (en ? eng : zh)
        const tick = () => {
          const s = readStatus(TARGET_DIR)
          const all = selfCheck(TARGET_DIR, { running: s.running })
          const bank = readBankInfo(TARGET_DIR)
          const hasBank = !!(bank && bank.count)
          const candidates = scanCandidates(TARGET_DIR, 4, { validate: true })
          const bad = all.filter((c) => c.ok === false && c.id !== 'run') // 没在跑是常态，不算缺项

          let tip
          let tipTone = 'info'
          if (!fs.existsSync(path.join(TARGET_DIR, 'ctl.sh'))) {
            tip = t('脚本还没部署好，重启一次引擎会自动装好。', 'Not deployed yet - restart the engine once.')
            tipTone = 'bad'
          } else if (bad.length) {
            tip = t('还差：', 'Missing: ') + bad.map((c) => c.label + '（' + c.hint + '）').join('；')
            tipTone = 'warn'
          } else if (!hasBank) {
            tip = t('没有题库也能用（模型直接作答）；想要正确答案，把题库文件放进「下载」目录再点「导入题库」。', 'Works without a bank; for official answers import a csv from Downloads.')
          } else if (!s.running) {
            tip = t('一切都就绪了，打开考试页，回来点「开始」。', 'All set - open the exam page, then tap Start.')
            tipTone = 'good'
          } else {
            tip = t('正在盯屏：切到下一题就会弹答案。', 'Watching: switch to the next question to get an answer.')
            tipTone = 'good'
          }

          const steps = [
            { label: t('点「开始」', 'Tap Start'), status: s.running ? 'done' : 'current', detail: s.running ? undefined : t('先开始盯屏，再切去考试页都行', 'Start first, then switch to the exam') },
            { label: t('打开考试页', 'Open exam page'), status: s.running ? (s.recent.length ? 'done' : 'current') : 'todo' },
            {
              label: t('看横幅拿答案', 'Read banner'),
              status: s.running ? (s.recent.length ? 'done' : 'current') : 'todo',
              detail: s.recent.length ? (s.recent[0].title + ' ' + (s.recent[0].subtitle || '')).trim() : undefined,
            },
          ]

          emit({
            state: s.running ? t('运行中', 'Running') : t('未运行', 'Stopped'),
            tone: s.running ? 'good' : 'info',
            caption: s.running ? (s.pid ? 'pid ' + s.pid : '') : t('点下面的「开始」', 'Tap Start below'),
            steps,
            tip,
            tipTone,
            checksSummary: bad.length
              ? t('环境自检：', 'Checks: ')
              : t('环境自检：全部正常', 'Checks: all good'),
            checks: all.map((c) => {
              const offline = c.id === 'run' && !s.running
              if (offline) return { label: '· ' + c.label, value: t('未运行，点上面的「开始」', 'Stopped - tap Start'), tone: 'muted' }
              return {
                label: (c.ok === true ? '✓ ' : c.ok === false ? '✗ ' : '· ') + c.label,
                value: c.ok === true ? (c.detail || t('已就绪', 'Ready')) : (c.hint || c.detail || ''),
                tone: c.ok === true ? 'good' : (c.ok === false ? 'bad' : 'muted'),
              }
            }),
            bankLine: hasBank
              ? t(`已导入 ${bank.count} 题（${bank.source}）`, `${bank.count} questions (${bank.source})`)
              : t('未导入', 'Not imported'),
            candidates: candidates.length
              ? candidates.map((c) => ({
                  title: (hasBank ? t('切换到：', 'Use: ') : t('导入：', 'Import: ')) + c.name,
                  trailing: t('导入', 'Import'),
                  tone: 'info',
                  icon: 'download',
                  subtitle: `${path.basename(path.dirname(c.file))} · ${formatSize(c.size)} · ${formatTime(c.mtime)}`,
                  action: { id: 'import', args: { file: c.file } },
                }))
              : [{
                  title: t('下载目录里没有题库文件', 'No bank file in Downloads'),
                  subtitle: t('把 csv / txt / json 放进手机「下载」目录，再点「重新扫描题库」', 'Put a csv/txt/json into Downloads, then Rescan'),
                }],
            faultHint: (() => {
              try {
                const logFile = path.join(TARGET_DIR, 'watch.log')
                const tail = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-40).join('\n')
                if (!/读屏被系统停止/.test(tail) || /读屏恢复/.test(tail.split('读屏被系统停止').pop())) return ''
                return t('读屏会话被系统停止了（多半是息屏导致）：打开 设置 → 手机操控，把顶部开关关一下再打开，然后回到考试页。', 'Phone control session was stopped by the system. Toggle Settings > Phone control off and on, then return to the exam page.')
              } catch { return '' }
            })(),
            scanHint: candidates.length
              ? t(`发现 ${candidates.length} 个题库文件，点任意一条导入`, `${candidates.length} bank file(s) found - tap one to import`)
              : t('没找到题库文件：把文件放到手机「下载」目录，或点上面的「重新扫描题库」', 'No bank file found in Downloads'),
            scanHintTone: candidates.length ? 'info' : 'warn',
            manualPath: '',
            importNote: lastImport && !lastImport.ok
              ? t('上次导入没成功：', 'Last import failed: ') + lastImport.file + '：' + lastImport.msg
              : ((candidates.length && !hasBank) ? t('点上面的文件即可导入', 'Tap a file above to import') : ''),
            recent: s.recent.length ? s.recent : [{ title: t('还没有作答记录', 'No answers yet'), subtitle: '' }],
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
        import: (scope, event) => doImport(event),
        importPath: (scope, event) => doImportPath(event),
        scan: (scope, event) => {
          const en = String((event && event.locale) || '').startsWith('en')
          const n = scanCandidates(TARGET_DIR, 4, { validate: true, force: true }).length
          lastImport = null
          return {
            toast: n
              ? (en ? `${n} usable bank file(s)` : `扫描完成：可用题库文件 ${n} 个`)
              : (en ? 'No bank file in Downloads' : '下载目录里没有能识别的题库文件'),
            refresh: true,
          }
        },
      },
    }))
  })
}
