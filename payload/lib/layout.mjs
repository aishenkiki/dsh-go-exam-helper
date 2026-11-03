// 版面分析：用坐标和「同组关系」定位选项，不依赖 A/B/C/D 这些标记。
//
// 三层依据，从强到弱：
//   1. 无障碍里已经拿到真实选项文本 → 在 OCR 行里找最像的那一行（字面相似度，容错），
//      第一个匹配到的选项行以上，就是题干；
//   2. 找不到足够匹配 → 用问号锚点（中文题目几乎都以问号结尾）；
//   3. 再不行 → 用「等高、同列、等距」的成组行找选项块。
// 字母只用来给选项排序和显示，没了、认错了都不影响判断。

const CHROME = /显示答案|备注|做对|做错|单选题|多选题|退出考试|题目导航|上一题|下一题|进度|答题卡/

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const norm = (s) => s.replace(/[^\p{L}\p{N}]/gu, '')

const CJK_PUNCT = '[\\p{Script=Han}，。？！、；：（）《》“”‘’…—]'
/** OCR 会在汉字之间插空格，去掉，保留英文单词之间的。 */
export function tidy (s) {
  return s
    .replace(new RegExp('(?<=' + CJK_PUNCT + ')\\s+', 'gu'), '')
    .replace(new RegExp('\\s+(?=' + CJK_PUNCT + ')', 'gu'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 字面相似度（按字符重合度），对 OCR 漏字、多字都比较宽容。 */
export function similarity (a, b) {
  const A = [...norm(a)]
  const B = [...norm(b)]
  if (!A.length || !B.length) return 0
  const pool = new Map()
  for (const c of A) pool.set(c, (pool.get(c) || 0) + 1)
  let common = 0
  for (const c of B) {
    const n = pool.get(c) || 0
    if (n > 0) { common++; pool.set(c, n - 1) }
  }
  return (2 * common) / (A.length + B.length)
}

/** 去掉行首标签：A. / A、/ (A) / ① ；没有也照样成立。 */
export function stripLabel (text) {
  return text
    .replace(/^[（(]\s*[A-Da-d１-４1-4]\s*[)）]\s*/, '')
    .replace(/^[A-Da-d]\s*[.、．:：)）]\s*/, '')
    .replace(/^[A-Da-d](?=[^\sA-Za-z0-9])/, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
    .trim()
}

function cleanLines (lines) {
  return lines
    .filter((l) => l.text.length >= 2)
    .filter((l) => !CHROME.test(l.text))
    .filter((l) => !/^\d{1,4}\s*\/\s*\d{1,5}$/.test(l.text))
    .map((l) => ({ ...l, text: tidy(l.text) }))
}

/**
 * @param {Array} lines OCR 行（带坐标）
 * @param {number} imgW 截图宽度
 * @param {Array<{letter:string,text:string}>} a11yOpts 无障碍里的真实选项（可为空）
 */
export function detect (lines, imgW, a11yOpts = []) {
  const content = cleanLines(lines)
  if (!content.length) return { question: '', options: [], ok: false, how: 'empty' }

  const lineH = median(content.map((l) => l.y1 - l.y0).filter((h) => h > 0)) || 20

  // 1) 用无障碍选项文本去 OCR 行里找锚点
  let cut = -1
  let how = ''
  let hits = []
  if (a11yOpts.length >= 3) {
    for (const o of a11yOpts) {
      let bestI = -1
      let bestS = 0
      content.forEach((l, i) => {
        const s = similarity(l.text, o.text)
        if (s > bestS) { bestS = s; bestI = i }
      })
      if (bestS >= 0.5) hits.push(bestI)
    }
    if (hits.length >= 2) { cut = Math.min(...hits); how = 'a11y-match' }
  }

  // 2) 问号锚点：题干最后一行通常以问号结尾
  if (cut < 0) {
    for (let i = content.length - 1; i >= 0; i--) {
      if (/[？?]\s*$/.test(content[i].text) && content[i].text.length >= 2) { cut = i + 1; how = 'question-mark'; break }
    }
  }

  // 3) 成组行：等高、同列、等距
  if (cut < 0) {
    let best = null
    for (let i = 0; i < content.length; i++) {
      for (let n = Math.min(6, content.length - i); n >= 3; n--) {
        const block = content.slice(i, i + n)
        const hs = block.map((l) => l.y1 - l.y0)
        if (Math.max(...hs) > Math.min(...hs) * 1.9) continue
        const xs = block.map((l) => l.x0)
        if (Math.max(...xs) - Math.min(...xs) > imgW * 0.18) continue
        const gaps = block.slice(1).map((l, k) => l.y0 - block[k].y0)
        const g = median(gaps)
        if (g <= lineH * 0.8 || g > lineH * 4) continue
        if (Math.max(...gaps) - Math.min(...gaps) > g * 0.9) continue
        const short = block.filter((l) => l.text.length <= 30).length
        if (!best || short > best.short) best = { short, start: i }
        break
      }
    }
    if (best) {
      // 块从第一行开始，说明题干行也被算了进来：第一行当题干，其余当选项
      cut = best.start === 0 && content.length >= 5 ? 1 : best.start
      how = 'block'
    }
  }

  // 4) 宽行块：题干以句号结尾、选项是裸数字（「A 1 / B 2」）时，前三条都不成立。
  //    这时直接把上方第一段「占宽 ≥45% 的连续正文行」当成题干；选项有 a11y 就不靠 OCR。
  if (cut < 0) {
    const narrow = (l) => l.x1 - l.x0 < imgW * 0.45
    const ui = /单选|多选|判断|进度|退出|导航|显示答案|备注|上一题|下一题|交卷|提交试卷|答题卡|做对|做错/
    let start = -1
    for (let i = 0; i < content.length; i++) {
      if (!narrow(content[i]) && !ui.test(content[i].text)) { start = i; break }
    }
    if (start >= 0) {
      let end = start + 1
      for (let i = start + 1; i < content.length && end - start < 3; i++) {
        const l = content[i]
        if (narrow(l) || ui.test(l.text)) break
        if (l.y0 - content[i - 1].y1 > lineH * 2.5) break
        end = i + 1
      }
      cut = end
      how = 'wide-block'
    }
  }

  if (cut < 0) return { question: '', options: [], ok: false, how: 'none' }

  // 题干：cut 上方连续、与题干同列、间距合理的行
  // 长题干（制度类题常有 4–5 行）只取 3 行会丢掉开头，所以多收两行留作备选：question 仍用后 3 行，
  // questionAlt 用全部行；查表先试 question，不中再试 alt，能救回「题干被截掉开头」的情况。
  const qLines = []
  for (let i = cut - 1; i >= 0 && qLines.length < 5; i--) {
    const l = content[i]
    // OCR 常在选项上方留一行纯符号（如 "@ |"、"日"），别把它拼进题干
    if (!/[\p{L}\p{N}]/u.test(String(l.text || ''))) continue
    if (qLines.length) {
      const gap = qLines[0].y0 - l.y1
      if (gap > lineH * 3.2) break
      if (Math.abs(l.x0 - qLines[0].x0) > imgW * 0.25) break
    }
    qLines.unshift(l)
  }
  const qTail = qLines.slice(-3)

  const options = (a11yOpts.length >= 3 ? a11yOpts : content.slice(cut))
    .slice(0, 6)
    .map((o, i) => ({ letter: o.letter || 'ABCDEF'[i], text: o.text || stripLabel(content[cut + i].text) }))

  // 题干尾部常混进下一行的角标（如 "9]"），去掉
  const trimQ = (ls) => tidy(ls.map((l) => l.text).join(''))
    .replace(/[\s\d]{1,3}[\]\)】]$/, '')
    .replace(/[\s]+$/, '')
  const question = trimQ(qTail)
  const questionAlt = qLines.length > qTail.length ? trimQ(qLines) : ''
  return { question, questionAlt, options, ok: question.length >= 6 && options.length >= 3, how, matched: typeof hits !== 'undefined' && hits ? hits.length : 0 }
}
