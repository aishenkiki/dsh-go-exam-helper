// 题库文件解析：尽量宽进——CSV / TSV / JSON / 纯文本，带不带表头都收，
// UTF-8 / BOM / GBK 自动识别，列名靠关键词猜。解析不了的行跳过并说明原因。

import { inflateRawSync } from 'node:zlib'

const LETTERS = 'ABCDEFGH'

export function decodeText (buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  // UTF-8 BOM
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.slice(3).toString('utf8')
  // GBK / GB18030：非法 UTF-8 时退回去试
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    try { return new TextDecoder('gb18030').decode(b) } catch { return b.toString('utf8') }
  }
}

export function sniffFormat (text, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const head = text.slice(0, 400).trim()
  if (ext === 'json' || head.startsWith('[') || head.startsWith('{')) return 'json'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'csv') return 'csv'
  const first = text.split(/\r?\n/, 1)[0] || ''
  if ((first.match(/\t/g) || []).length >= 2) return 'tsv'
  if ((first.match(/,/g) || []).length >= 2) return 'csv'
  return 'text'
}

// 极简 CSV 解析：支持双引号包裹、引号内逗号与换行、"" 转义
export function parseDelimited (text, delim) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === delim) { row.push(field); field = ''; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (c === '\r') continue
    field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.map((r) => r.map((s) => s.trim())).filter((r) => r.some((s) => s !== ''))
}

function guessDelimiter (text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || ''
  const count = (ch) => (line.match(new RegExp('\\' + ch, 'g')) || []).length
  const cands = [[',', count(',')], ['\t', count('\t')], [';', count(';')], ['|', count('|')]]
  cands.sort((a, b) => b[1] - a[1])
  return cands[0][1] > 0 ? cands[0][0] : ','
}

const Q_HEAD = /^(题干|题目|问题|试题|question|stem|title|q)$/i
const A_HEAD = /^(正确答案|答案|正确选项|answer|key|correct)$/i
const OPT_HEAD = /^(答案|选项|option|opt)?\s*[（(]?([A-H])[)）]?$/i
const NOISE_HEAD = /^(序号|编号|id|no|index|题目类型|类型|题型|题目分类|分类|类别|category|章节|来源|source|是否.*|备注|remark|难度|difficulty)$/i

function headerScore (row) {
  let score = 0
  for (const c of row) {
    if (Q_HEAD.test(c)) score += 3
    else if (A_HEAD.test(c)) score += 2
    else if (OPT_HEAD.test(c)) score += 2
  }
  return score
}

function normAns (v) {
  const s = String(v || '').trim().toUpperCase().replace(/[^A-H]/g, '')
  return s.length === 1 ? s : ''
}

function letterAt (i) { return LETTERS[i] || '' }

// 把「行 + 列映射」变成题目对象；失败给原因
function rowToItem (row, map) {
  const q = (row[map.q] || '').trim()
  if (!q) return { skip: '题干是空的' }
  if (q.length < 4) return { skip: '题干太短' }
  const options = []
  for (const [idx, letter] of map.opts) {
    const text = (row[idx] || '').trim()
    if (text) options.push({ letter, text })
  }
  if (options.length < 2) return { skip: '选项少于 2 个' }
  let answer = ''
  if (map.a >= 0) {
    const raw = (row[map.a] || '').trim()
    answer = normAns(raw)
    if (!answer) {
      // 答案写的是选项原文，用它回查字母
      const hit = options.find((o) => o.text === raw || o.text.replace(/\s/g, '') === raw.replace(/\s/g, ''))
      answer = hit ? hit.letter : ''
    }
  }
  if (!answer || !options.some((o) => o.letter === answer)) return { skip: '答案对不上任何选项' }
  return { item: { q, options, answer } }
}

function mapFromHeader (header) {
  const map = { q: -1, a: -1, opts: [] }
  header.forEach((h, i) => {
    const cell = String(h || '').trim()
    if (map.q < 0 && Q_HEAD.test(cell)) { map.q = i; return }
    if (map.a < 0 && A_HEAD.test(cell)) { map.a = i; return }
    const m = cell.match(OPT_HEAD)
    if (m && m[2]) { map.opts.push([i, m[2].toUpperCase()]); return }
    if (/^(答案|选项|option|opt)/i.test(cell) && !NOISE_HEAD.test(cell)) map.opts.push([i, ''])
  })
  // 选项列按出现顺序补字母
  map.opts = map.opts.map(([i], k) => [i, map.opts[k][1] || letterAt(k)])
  return map
}

// 没表头：题干 = 平均字数最长的一列；答案 = 大多是单个 A-H 的列；
// 选项 = 其余“短且重复度高”的列，按位置补字母。
function mapByGuess (rows) {
  const sample = rows.slice(0, Math.min(rows.length, 30))
  const width = Math.max(...rows.map((r) => r.length))
  const stats = []
  for (let i = 0; i < width; i++) {
    const vals = sample.map((r) => (r[i] || '').trim()).filter(Boolean)
    const avg = vals.reduce((s, v) => s + v.length, 0) / (vals.length || 1)
    const letterRatio = vals.filter((v) => /^[A-H]$/i.test(v)).length / (vals.length || 1)
    const numRatio = vals.filter((v) => /^\d+$/.test(v)).length / (vals.length || 1)
    stats.push({ i, avg, letterRatio, numRatio, n: vals.length })
  }
  const q = stats.filter((s) => s.n && s.numRatio < 0.8).sort((a, b) => b.avg - a.avg)[0]
  const a = stats.filter((s) => s !== q && s.letterRatio > 0.6).sort((x, y) => x.avg - y.avg)[0]
  const minFill = Math.max(2, Math.floor(sample.length * 0.3))
  let opts
  if (q && a && a.i > q.i) {
    // 有答案列：题干与答案列之间的列就是选项列（空列不影响，后面会跳过）
    opts = stats.filter((s) => s.i > q.i && s.i < a.i)
  } else {
    opts = stats
      .filter((s) => s !== q && s !== a && s.n >= minFill && s.numRatio < 0.8 && s.avg > 0 && s.avg < 80)
      .filter((s) => !(a && s.i === a.i))
  }
  const map = { q: q ? q.i : -1, a: a ? a.i : -1, opts: opts.slice(0, 8).map((s, k) => [s.i, letterAt(k)]) }
  return map
}

function parseJsonBank (text, stats) {
  let data
  try { data = JSON.parse(text) } catch (e) { stats.fatal = 'JSON 解析失败：' + e.message; return [] }
  const list = Array.isArray(data) ? data : (data.questions || data.items || data.list || data.data || [])
  if (!Array.isArray(list)) { stats.fatal = 'JSON 里没找到题目数组'; return [] }
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { stats.skipped.push({ reason: '不是对象' }); continue }
    const q = raw.q || raw.question || raw.题干 || raw.title || raw.stem || ''
    const ansRaw = raw.answer || raw.答案 || raw.key || raw.correct || ''
    let opts = raw.options || raw.选项 || raw.choices || []
    if (opts && !Array.isArray(opts) && typeof opts === 'object') {
      opts = Object.keys(opts).sort().map((k) => ({ letter: k.toUpperCase(), text: opts[k] }))
    }
    const options = (opts || []).map((o, i) => {
      if (typeof o === 'string') return { letter: letterAt(i), text: o }
      return { letter: String(o.letter || o.key || letterAt(i)).toUpperCase(), text: String(o.text || o.value || o.label || '') }
    }).filter((o) => o.text)
    const answer = normAns(ansRaw) || (options.find((o) => o.text === String(ansRaw).trim()) || {}).letter || ''
    if (!String(q).trim()) { stats.skipped.push({ reason: '题干是空的' }); continue }
    if (options.length < 2) { stats.skipped.push({ reason: '选项少于 2 个' }); continue }
    if (!answer || !options.some((o) => o.letter === answer)) { stats.skipped.push({ reason: '答案对不上任何选项' }); continue }
    out.push({ q: String(q).trim(), options, answer })
  }
  return out
}

function parsePlainText (text, stats) {
  // 形如：1. 题干…… / A. 选项 / B. 选项 / 答案：C
  const out = []
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const q = lines[0].replace(/^\d+[.、)．]\s*/, '')
    const options = []
    let answer = ''
    for (const l of lines.slice(1)) {
      const om = l.match(/^([A-H])[.、)．:：]\s*(.+)$/i)
      if (om) { options.push({ letter: om[1].toUpperCase(), text: om[2].trim() }); continue }
      const am = l.match(/^(答案|正确答案|answer)[:：]\s*(.+)$/i)
      if (am) { answer = normAns(am[2]) || (options.find((o) => o.text === am[2].trim()) || {}).letter || '' }
    }
    if (q && options.length >= 2 && answer) out.push({ q, options, answer })
    else stats.skipped.push({ reason: '这一块不是完整题目' })
  }
  return out
}


// ---------- xlsx（只依赖 node:zlib，解 zip + 读 sheet1） ----------
const CRC = null

function unzipEntries (buf) {
  // 从尾部找 EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOff = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    out.set(name, { method, compSize, localOff })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function readZipFile (buf, entries, name) {
  const e = entries.get(name)
  if (!e) return null
  const lh = e.localOff
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null
  const nameLen = buf.readUInt16LE(lh + 26)
  const extraLen = buf.readUInt16LE(lh + 28)
  const start = lh + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compSize)
  if (e.method === 0) return raw.toString('utf8')
  return inflateRawSync(raw).toString('utf8')
}

function xmlText (s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
    .trim()
}

function colIndex (ref) {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return -1
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function xlsxToRows (buf) {
  const entries = unzipEntries(buf)
  const sharedXml = readZipFile(buf, entries, 'xl/sharedStrings.xml') || ''
  const shared = []
  for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1]))
  let sheetName = 'xl/worksheets/sheet1.xml'
  if (!entries.has(sheetName)) {
    sheetName = [...entries.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)) || ''
    if (!sheetName) throw new Error('xlsx 里没有工作表')
  }
  const sheetXml = readZipFile(buf, entries, sheetName) || ''
  const rows = []
  for (const r of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = []
    // 注意：空单元格会写成 <c ... />，不能再按 <c ...>...</c> 硬配，否则会把后面的单元格吞掉
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]
      const body = c[2] || ''
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1] || ''
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || ''
      let val = ''
      if (type === 's') {
        const idx = +(/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]
        val = shared[idx] || ''
      } else if (type === 'inlineStr') {
        val = xmlText((/<is>([\s\S]*?)<\/is>/.exec(body) || [])[1] || '')
      } else {
        val = xmlText((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '')
      }
      const ci = colIndex(ref)
      if (ci >= 0) cells[ci] = val
      else cells.push(val)
    }
    if (cells.some((v) => v && String(v).trim())) rows.push(cells.map((v) => (v == null ? '' : v)))
  }
  return rows
}

// 行数组 → 题库条目（CSV 和 xlsx 共用）
function rowsToItems (rows, stats) {
  if (!rows.length) { stats.fatal = '文件是空的'; return [] }
  const hasHeader = headerScore(rows[0]) >= 4
  const dataRows = hasHeader ? rows.slice(1) : rows
  const map = hasHeader ? mapFromHeader(rows[0]) : mapByGuess(dataRows)
  if (map.q < 0) { stats.fatal = '没找到题干列'; return [] }
  stats.map = map
  const items = []
  for (const row of dataRows) {
    stats.total++
    const r = rowToItem(row, map)
    if (r.item) items.push(r.item)
    else stats.skipped.push({ reason: r.skip, sample: String(row[map.q] || '').slice(0, 24) })
  }
  return items
}

export function parseBankFile (buf, filename = '') {
  const stats = { total: 0, ok: 0, skipped: [], format: '' }
  // xlsx/xlsm 是 zip 包，先按魔数认出来
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    stats.format = 'xlsx'
    try {
      const rows = xlsxToRows(buf)
      stats.rows = rows.length
      const items = rowsToItems(rows, stats)
      stats.ok = items.length
      if (!stats.total) stats.total = items.length + stats.skipped.length
      return { items, stats }
    } catch (e) {
      stats.fatal = '读不了这个 Excel：' + (e && e.message)
      return { items: [], stats }
    }
  }
  const text = decodeText(buf)
  const format = sniffFormat(text, filename)
  stats.format = format
  let items = []
  if (format === 'json') {
    items = parseJsonBank(text, stats)
  } else if (format === 'text') {
    items = parsePlainText(text, stats)
  } else {
    const delim = format === 'tsv' ? '\t' : guessDelimiter(text)
    const rows = parseDelimited(text, delim)
    if (!rows.length) { stats.fatal = '文件是空的'; return { items: [], stats } }
    const hasHeader = headerScore(rows[0]) >= 4
    const dataRows = hasHeader ? rows.slice(1) : rows
    const map = hasHeader ? mapFromHeader(rows[0]) : mapByGuess(dataRows)
    if (map.q < 0) { stats.fatal = '没找到题干预'; return { items: [], stats } }
    stats.map = map
    for (const row of dataRows) {
      stats.total++
      const r = rowToItem(row, map)
      if (r.item) items.push(r.item)
      else stats.skipped.push({ reason: r.skip, sample: (row[map.q] || '').slice(0, 24) })
    }
  }
  stats.ok = items.length
  if (!stats.total) stats.total = items.length + stats.skipped.length
  return { items, stats }
}

export function summarizeParse (stats) {
  const parts = [`${stats.ok}/${stats.total} 题`]
  if (stats.skipped.length) {
    const byReason = new Map()
    for (const s of stats.skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1)
    parts.push([...byReason].map(([r, n]) => `${r} ${n}`).join('，'))
  }
  return parts.join('｜')
}
