// 多候选 + 自评分：不再由我猜「该用哪个语言模型、哪种版面切分」，
// 而是把几种组合都跑一遍，用结构证据给结果打分，挑最好的那个。
//
// 评分依据（都是结构信号，不含任何 App 专属知识）：
//   · 题干以问号结尾                     +30
//   · 无障碍选项在 OCR 行里被找到几个     每个 +10
//   · 题干长度                          最多 +15
//   · 退化成「成组行」推断得到的          -5（证据弱一档）
import { ocrLines } from './ocr-tsv.mjs'
import { detect } from './layout.mjs'

const CONFIDENT = 55

function score (r) {
  if (!r.ok) return -1
  let s = 0
  if (r.how === 'a11y-match') s += 25          // 选项在 OCR 里逐条对上，证据最强
  s += Math.min(40, (r.matched || 0) * 10)
  if (/[？?]\s*$/.test(r.question)) s += 20    // 有问号更好，但没有问号的题也合法
  s += Math.min(15, r.question.length / 4)
  if (r.how === 'block') s -= 10               // 纯靠等距推断，证据弱
  return Math.round(s)
}

/**
 * @returns {{question:string, options:Array, how:string, score:number, candidates:Array}|null}
 */
export async function analyze (jpgPath, a11yOpts = []) {
  const ascii = a11yOpts.map((o) => o.text).join('')
  const latin = ascii ? [...ascii].filter((c) => /[A-Za-z0-9]/.test(c)).length / [...ascii].length : 0
  const first = latin > 0.4 ? 'chi_sim+eng' : 'chi_sim'
  const second = first === 'chi_sim' ? 'chi_sim+eng' : 'chi_sim'

  const candidates = []
  for (const [langs, psm] of [[first, 6], [second, 6], [first, 4]]) {
    let lines = []
    try {
      lines = await ocrLines(jpgPath, psm, langs)
    } catch {
      continue
    }
    if (!lines.length) continue
    const imgW = Math.max(...lines.map((l) => l.x1)) + 40
    const r = detect(lines, imgW, a11yOpts)
    const c = { ...r, langs, psm, score: score(r) }
    candidates.push(c)
    if (c.score >= CONFIDENT + 25) break      // 已经很确定，不必再花时间
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (best.score < CONFIDENT) return { ...best, candidates, weak: true }
  return { ...best, candidates }
}

/**
 * 只跑一次 OCR（chi_sim + psm 6）的快速版，给「先查题库」用：
 * 题库命中就不必再调视觉模型，能省掉约 1 秒和一次调用成本。
 * 结果不设阈值——查表那边还有相似度与选项对位把关。
 */
export async function analyzeFast (jpgPath, a11yOpts = []) {
  let lines = []
  try {
    lines = await ocrLines(jpgPath, 6, 'chi_sim')
  } catch {
    return null
  }
  if (!lines.length) return null
  const imgW = Math.max(...lines.map((l) => l.x1)) + 40
  const out = detect(lines, imgW, a11yOpts)
  return out ? { ...out, prog: progressFromText(lines) } : out
}

/** 顶部「进度 6 / 2323」有时不在无障碍树里，但一定在截图里 */
function progressFromText (lines) {
  for (const l of lines.slice(0, 6)) {
    const m = String(l.text || '').match(/(\d{1,4})\s*\/\s*(\d{2,5})/)
    if (m) return { current: Number(m[1]), total: Number(m[2]) }
  }
  return null
}
