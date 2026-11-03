// 截图 → OCR（带坐标）→ 行。后续版面分析全靠坐标，不依赖文字里的 A/B/C/D。
import { execFile } from 'node:child_process'
import fs from 'node:fs'

const PREP = `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('L')
w, h = im.size
if w < 1200:
    im = im.resize((w * 2, h * 2), Image.LANCZOS)
im.save(dst)
`

export const CJK = /[\u4e00-\u9fff]/

/** 运行 tesseract，拿 TSV（带坐标）。 */
export function tesseractTsv (file, psm = 6, langs = 'chi_sim') {
  // 注意：chi_sim+eng 在中文截图里反而会把汉字认错（英文模型抢字符），
  // 所以默认只用 chi_sim；选项是英文时才用混合模型。
  return new Promise((resolve) => {
    execFile('tesseract', [file, 'stdout', '-l', langs, '--psm', String(psm), 'tsv'],
      { timeout: 25000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => resolve(out || ''))
  })
}

export function upscale (src, dst) {
  return new Promise((resolve) => {
    execFile('/usr/bin/python3', ['-c', PREP, src, dst], { timeout: 15000 }, () => resolve(fs.existsSync(dst) ? dst : src))
  })
}

/** TSV → 词（带坐标），再按 tesseract 的行号聚成行。 */
export function parseTsv (tsv) {
  const lines = new Map()
  for (const row of tsv.split('\n')) {
    const c = row.split('\t')
    if (c.length < 12) continue
    const [level, , block, par, line, , left, top, width, height, conf, ...rest] = c
    const text = rest.join(' ').trim()
    if (level !== '5' || !text) continue
    if (Number(conf) < 30) continue
    const key = `${block}:${par}:${line}`
    const x0 = Number(left); const y0 = Number(top)
    const x1 = x0 + Number(width); const y1 = y0 + Number(height)
    const cur = lines.get(key)
    if (!cur) lines.set(key, { words: [{ text, x0, y0, x1, y1, conf: Number(conf) }] })
    else cur.words.push({ text, x0, y0, x1, y1, conf: Number(conf) })
  }
  return [...lines.values()].map(({ words }) => {
    words.sort((a, b) => a.x0 - b.x0)
    let text = ''
    for (const w of words) {
      if (!text) { text = w.text; continue }
      text += CJK.test(text.slice(-1)) && CJK.test(w.text[0]) ? w.text : ' ' + w.text
    }
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      x0: Math.min(...words.map((w) => w.x0)),
      y0: Math.min(...words.map((w) => w.y0)),
      x1: Math.max(...words.map((w) => w.x1)),
      y1: Math.max(...words.map((w) => w.y1)),
      words,
    }
  }).sort((a, b) => a.y0 - b.y0)
}

export async function ocrLines (jpgPath, psm = 6, langs = 'chi_sim') {
  const png = jpgPath.replace(/\.jpg$/, '.png')
  const src = await upscale(jpgPath, png)
  return parseTsv(await tesseractTsv(src, psm, langs))
}
