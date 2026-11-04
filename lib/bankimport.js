// 题库导入：把用户下载的 csv/tsv/json/txt 解析成 bank.json 放进运行目录。
// 面板点「导入题库」时走这里，解析器见 payload/lib/bankfile.mjs（宽进：编码、分隔符、表头都能猜）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBankFile, summarizeParse } from '../payload/lib/bankfile.mjs'

const EXTS = new Set(['.csv', '.tsv', '.json', '.txt', '.xlsx', '.xlsm'])
const MAX_SIZE = 20 * 1024 * 1024

export function bankPath (targetDir) {
  return path.join(targetDir, 'bank.json')
}

/** 现有题库的概况：没导入过就是 null。按 mtime 缓存，面板每 5 秒刷新时不重复解析 700KB JSON。 */
let bankInfoCache = { file: '', mtime: -1, info: null }
export function readBankInfo (targetDir) {
  const file = bankPath(targetDir)
  let mtime = -1
  try { mtime = fs.statSync(file).mtimeMs } catch { return null }
  if (bankInfoCache.file === file && bankInfoCache.mtime === mtime) return bankInfoCache.info
  let info = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(raw.items) ? raw.items : []
    info = { count: items.length, source: raw.source || path.basename(file), builtAt: raw.builtAt || '', file }
  } catch {
    info = null
  }
  bankInfoCache = { file, mtime, info }
  return info
}

function scanDir (dir, depth, out, b) {
  if (!b) b = budgets()
  if (b.dirs++ > 600 || b.files > 6000 || Date.now() > b.until) return
  let names
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const d of names) {
    if (out.length > 200) return
    const full = path.join(dir, d.name)
    if (d.isDirectory()) {
      if (depth > 0 && !d.name.startsWith('.')) scanDir(full, depth - 1, out, b)
      continue
    }
    b.files++
    const ext = path.extname(d.name).toLowerCase()
    if (!EXTS.has(ext)) continue
    if (d.name === 'bank.json') continue
    try {
      const st = fs.statSync(full)
      if (st.size > 0 && st.size < MAX_SIZE) out.push({ file: full, name: d.name, size: st.size, mtime: st.mtimeMs })
    } catch {}
  }
}

/** 轻量校验：真的能解析出题目才算候选。按 文件+mtime 缓存，避免面板每 5 秒重复解析。 */
const verified = new Map()
function looksLikeBank (f) {
  const key = f.file + ':' + f.mtime
  if (verified.has(key)) return verified.get(key)
  let ok = false
  try {
    const { items } = parseBankFile(fs.readFileSync(f.file), f.name)
    ok = items.length >= 3
  } catch {}
  verified.set(key, ok)
  if (verified.size > 50) verified.clear()
  return ok
}

// 不扫这些：系统/媒体目录，扫了也是浪费
const SKIP_TOP = new Set(['Android', 'DCIM', 'Movies', 'Music', 'Pictures', 'Alarms', 'Ringtones',
  'Notifications', 'Podcasts', 'TTS', 'Fonts', 'Sounds', 'Recordings'])

function budgets () {
  return { dirs: 0, files: 0, until: Date.now() + 2500 }
}

/** 手机存储里所有可能放题库的地方：下载/文档 + 存储根目录下各文件夹（有预算上限，不会卡住） */
let scanCache = { key: '', at: 0, list: null }
const SCAN_TTL = 60_000

export function scanCandidates (targetDir, limit = 6, { validate = false, force = false } = {}) {
  const key = targetDir + '|' + limit + '|' + validate
  const now = Date.now()
  if (!force && scanCache.list && scanCache.key === key && now - scanCache.at < SCAN_TTL) return scanCache.list
  const out = []
  const b = budgets()
  const roots = [
    '/sdcard/Download',
    '/sdcard/Downloads',
    '/sdcard/Documents',
    path.join(os.homedir(), 'Download'),
    path.join(os.homedir(), 'Documents'),
    targetDir,
  ]
  for (const d of new Set(roots)) scanDir(d, 3, out, b)
  // 存储根目录下的其它文件夹（123云盘、我的文件、微信下载……）
  let tops = []
  try { tops = fs.readdirSync('/sdcard', { withFileTypes: true }).filter((d) => d.isDirectory()) } catch {}
  for (const d of tops) {
    if (SKIP_TOP.has(d.name) || d.name.startsWith('.')) continue
    scanDir(path.join('/sdcard', d.name), 2, out, b)
  }
  const seen = new Set()
  const list = out
    .sort((a, b) => b.mtime - a.mtime)
    .filter((f) => {
      // 同名同大小的重复文件（微信/云盘各存一份）只留最新的
      const k = f.name + ':' + f.size
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  const final = (validate ? list.filter(looksLikeBank) : list).slice(0, limit)
  scanCache = { key, at: Date.now(), list: final }
  return final
}

export function formatSize (n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n > 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

export function formatTime (ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 解析并写入 bank.json；返回 {ok, msg, count, stats} */
export function importBankFile (targetDir, file) {
  const ext = path.extname(file).toLowerCase()
  if (!EXTS.has(ext)) return { ok: false, msg: '不支持这种文件类型：' + (ext || '无扩展名'), count: 0 }
  try {
    const st = fs.statSync(file)
    if (st.size > MAX_SIZE) return { ok: false, msg: `文件太大（${formatSize(st.size)}，上限 20 MB）`, count: 0 }
    if (st.size === 0) return { ok: false, msg: '文件是空的', count: 0 }
  } catch (e) {
    return { ok: false, msg: '读不到文件：' + (e && e.message), count: 0 }
  }
  let buf
  try { buf = fs.readFileSync(file) } catch (e) { return { ok: false, msg: '读不到文件：' + (e && e.message), count: 0 } }
  const { items, stats } = parseBankFile(buf, path.basename(file))
  if (!items.length) {
    return { ok: false, msg: (stats.fatal ? stats.fatal + '；' : '') + '没有解析出题目', count: 0, stats }
  }
  const noAnswer = (stats.skipped || []).filter((s) => s.reason === '答案对不上任何选项').length
  const payload = {
    builtAt: new Date().toISOString(),
    source: path.basename(file),
    count: items.length,
    items,
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    const tmp = bankPath(targetDir) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, bankPath(targetDir))
  } catch (e) {
    return { ok: false, msg: '写入失败：' + (e && e.message), count: 0, stats }
  }
  const msg = summarizeParse(stats) + (noAnswer ? `（这份文件有 ${noAnswer} 行没写正确答案，已跳过）` : '')
  return { ok: true, msg, count: items.length, stats }
}

/** 面板上的自检项：能自动查的自动查，查不了的给一句提示 */
export function selfCheck (targetDir, { running } = {}) {
  const items = []
  const ctl = path.join(targetDir, 'ctl.sh')
  items.push({
    id: 'deploy',
    label: '脚本已部署',
    ok: fs.existsSync(ctl),
    hint: '重启 DSH Go 引擎会自动部署；仍失败就看 plugin-err.log',
  })
  items.push({
    id: 'bridge',
    label: '手机桥接可用',
    ok: fs.existsSync('/var/lib/dsh-app/phone/bridge.json'),
    hint: '在 DSH Go 设置里打开「手机操控」，并允许无障碍',
  })
  items.push({
    id: 'cred',
    label: '模型凭据',
    ok: fs.existsSync(path.join(os.homedir(), '.dsh', '.credentials.yaml')),
    hint: '在 DSH 设置 → 模型里登录一个账号',
  })
  const bank = readBankInfo(targetDir)
  items.push({
    id: 'bank',
    label: '题库',
    ok: !!bank && bank.count > 0,
    detail: bank ? `${bank.count} 题` : '未导入（可只用模型）',
    hint: '把 csv/json 题库放进下载目录，点「导入题库」',
  })
  items.push({
    id: 'notify',
    label: '通知横幅',
    ok: null, // 系统设置读不到，只能提示
    detail: '建议设为「横幅」，否则答案只在通知栏',
    hint: '设置 → 通知 → DSH Go → 横幅/紧急',
  })
  if (running !== undefined) {
    items.push({ id: 'run', label: '后台监考', ok: !!running, detail: running ? '运行中' : '未开始' })
  }
  return items
}
