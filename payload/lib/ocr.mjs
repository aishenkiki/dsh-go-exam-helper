// 截图 → 带坐标的 OCR → 版面分析 → 题干。
// 选项始终用无障碍里的原文（准确），OCR 只负责「题干在哪」和「题干是什么」。
import fs from 'node:fs'
import { ocrLines } from './ocr-tsv.mjs'
import { detect } from './layout.mjs'

/** 截图 → {question, options, how}；失败返回 null，并把 OCR 原文留在旁边便于排查。 */
export async function readQuestionFromShot (jpgPath, a11yOpts = []) {
  // 选项主要是英文时用混合模型，否则只用中文模型（中文模型在中文页面上明显更准）
  const ascii = a11yOpts.map((o) => o.text).join('')
  const latinShare = ascii ? ([...ascii].filter((c) => /[A-Za-z0-9]/.test(c)).length / [...ascii].length) : 0
  const primary = latinShare > 0.4 ? 'chi_sim+eng' : 'chi_sim'
  const other = primary === 'chi_sim' ? 'chi_sim+eng' : 'chi_sim'

  let last = []
  for (const [langs, psm] of [[primary, 6], [primary, 4], [other, 6]]) {
    let lines = []
    try {
      lines = await ocrLines(jpgPath, psm, langs)
    } catch {
      continue
    }
    if (!lines.length) continue
    last = lines
    const imgW = Math.max(...lines.map((l) => l.x1)) + 40
    const r = detect(lines, imgW, a11yOpts)
    if (r.ok) return { question: r.question, options: r.options, how: `${r.how}/${langs}/psm${psm}` }
  }

  if (last.length) {
    try {
      fs.writeFileSync(jpgPath.replace(/\.jpg$/, '-ocr.txt'),
        last.map((l) => `${Math.round(l.y0)}\t${Math.round(l.x0)}\t${l.text}`).join('\n'))
    } catch {}
  }
  return null
}
