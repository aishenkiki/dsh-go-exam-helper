// 题库查表：题干（+选项）→ 答案
// 设计目标：优先精确命中，其次高相似度模糊命中；模糊命中必须唯一且够像，宁可不答也不答错。
import fs from 'node:fs'
import path from 'node:path'

const BANK_FILE = 'bank.json'
const FUZZY_MIN = 0.85   // 字符级相似度（Levenshtein）阈值：比 bigram 宽容，能容 1–2 个 OCR 错字
const OPTION_AGREE_MIN = 0.75
const GRAM_PREFILTER = 0.55 // bigram 粗筛，低于它就跳过昂贵的编辑距离

/** 统一全半角、去空白和标点，只留下文字与数字 */
export function norm(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：？！“”‘’"'（）()《》〈〉【】\[\]{}…—\-~·.,;:?!/\\|+*=<>@#$%^&_`]/g, '')
}

/** OCR 常把界面上「点击查看…」之类的按钮文字粘到题干尾部，先切掉再匹配 */
export function stripTailNoise(text) {
  return String(text || '')
    .replace(/(点击查看|点击查询|点击阅读|点击查看内容|点击展开)[\s\S]*$/, '')
    .replace(/[。．.、,，;；:：!！?？\-—_·]{2,}$/, '')
    .trim()
}

/** 字符级编辑距离相似度：0–1，1 表示完全一致 */
export function levenshteinRatio(a, b) {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const m = a.length
  const n = b.length
  let prev = new Array(n + 1)
  let cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const t = prev; prev = cur; cur = t
  }
  return 1 - prev[n] / Math.max(m, n)
}

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export class Bank {
  constructor(raw) {
    this.items = raw.items || []
    this.byQuestion = new Map()
    this.grams = []
    for (const item of this.items) {
      const qn = norm(item.q)
      if (!this.byQuestion.has(qn)) this.byQuestion.set(qn, item)
      this.grams.push({ item, qn, grams: bigrams(qn) })
    }
  }

  get size() {
    return this.items.length
  }

  /**
   * @param {string} question 题干文字（无障碍/OCR/视觉得到的都行）
   * @param {string[]} [options] 选项原文，可选
   * @returns {{answer:string, text:string, match:'exact'|'contains'|'fuzzy', similarity:number}|null}
   */
  lookup(question, options) {
    const qn = norm(stripTailNoise(question))
    if (qn.length < 6) return null

    const exact = this.byQuestion.get(qn)
    if (exact && this.optionsAgree(exact, options)) return hit(exact, 'exact', 1)
    if (exact) return hit(exact, 'exact', 1)

    // OCR 常把题干首行或末行切掉，这时精确/相似度都会失手：
    // 只要这段文字被完整包含在某条题干里（且长度够），就算命中，再用选项校验一次。
    if (qn.length >= 12) {
      const inside = this.grams.filter((r) => r.qn.includes(qn) && this.optionsAgree(r.item, options))
      if (inside.length === 1) return hit(inside[0].item, 'contains', 1)
      // OCR 常在题干后面粘上装饰字符（「…目标是9一:一」）：只要题库题干被这段文字包含就算命中
      const wrapped = this.grams.filter((r) => r.qn.length >= 8 && qn.includes(r.qn) && this.optionsAgree(r.item, options))
      if (wrapped.length === 1) return hit(wrapped[0].item, 'contains', 1)
    }

    let best = null
    let second = 0
    const grams = bigrams(qn)
    for (const row of this.grams) {
      // 先用长度与 bigram 粗筛，跳过明显不同的题，省掉编辑距离的开销
      if (Math.abs(row.qn.length - qn.length) > Math.max(8, qn.length * 0.4)) continue
      if (jaccard(grams, row.grams) < GRAM_PREFILTER) continue
      const score = levenshteinRatio(qn, row.qn)
      if (!best || score > best.score) {
        second = best ? best.score : 0
        best = { row, score }
      } else if (score > second) second = score
    }
    if (!best || best.score < FUZZY_MIN) return null
    if (second >= FUZZY_MIN) return null // 有并列候选，不敢猜
    if (!this.optionsAgree(best.row.item, options)) return null
    return hit(best.row.item, 'fuzzy', Number(best.score.toFixed(3)))
  }

  /** 选项能对上就对上（应对同题干不同选项的脏数据）；没有选项时不否决 */
  optionsAgree(item, options) {
    if (!options || options.length < 2) return true
    const given = options.map((o) => norm(typeof o === 'string' ? o : o.text)).filter(Boolean)
    if (!given.length) return true
    const banked = item.options.map((o) => norm(o.text))
    let agree = 0
    for (const g of given) if (banked.some((b) => b && (b === g || b.includes(g) || g.includes(b)))) agree++
    return agree / given.length >= OPTION_AGREE_MIN
  }
}

function hit(item, match, similarity) {
  const letter = item.answer.slice(0, 1)
  const text = (item.options.find((o) => o.letter === letter) || {}).text || ''
  return { answer: letter, text, match, similarity }
}

let cached = null

/** 从目录里读 bank.json（没有就返回 null） */
export function loadBank(dir) {
  if (cached) return cached
  const file = path.join(dir, BANK_FILE)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    cached = new Bank(raw)
    return cached
  } catch {
    return null
  }
}
