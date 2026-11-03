// 屏幕文字 → 结构化题目。
// 输入是手机桥接 screen 工具的文本输出，形状大致是：
//   屏幕 s12 · 应用名 · 竖屏 · 键盘收起 · 共 14 项
//   顶部
//     [1] 展开操作按钮
//   中部
//     [4] 进度 4 / 7 · ... · 单选题
//     [9] 按钮 Apush()
// 目标：不依赖具体 App，只靠结构特征认出「题干 + 四个选项 + 题号」。

const ROLE = /^(按钮|文本|图片|进度|输入框|开关|复选框|列表|弹窗|提示|标题)\s+/
const CHROME = /^(顶部|中部|底部|列表)$/

/** 把一段屏读文本拆成 {role, text} 元素。 */
export function elements (dump) {
  const out = []
  for (const line of String(dump).split('\n')) {
    if (/^屏幕 s\d+/.test(line.trim())) continue
    for (const seg of line.split(/\s{2,}/)) {
      let t = seg.trim()
      if (!t) continue
      if (CHROME.test(t)) continue
      // 元素前可能带装饰标记（+ / ⚠ 等），统一剥掉再认编号
      const m = t.match(/^[^\p{L}\p{N}]{0,4}\[(\d+)\]\s*(.*)$/u)
      if (m) t = m[2].trim()
      if (!t) continue
      const r = t.match(ROLE)
      let text = (r ? t.slice(r[0].length) : t).trim()
      // 「列表 [3] 可上下滑」这类：剥角色前缀后还留着编号和滚动提示，都要清掉，
      // 否则会被当成题干候选（真实案例：一句「[3] 可上下滑」被当题干发了出去）。
      text = text.replace(/^\[\d+\]\s*/, '').trim()
      if (!text || /^可(上下|左右)滑$|^可滑动$/.test(text)) continue
      out.push({ role: r ? r[1] : '', text })
    }
  }
  return out.filter((e) => e.text)
}

export function appName (dump) {
  const m = String(dump).match(/^屏幕 s\d+ · ([^·]+) ·/m)
  return m ? m[1].trim() : ''
}

/** 「进度 4 / 7」这类题号；没有就返回 null。 */
export function progress (els) {
  for (const e of els) {
    const m = e.text.match(/(\d{1,4})\s*\/\s*(\d{1,5})/)
    if (!m) continue
    const strong = e.role === '进度' || /^\s*\d+\s*\/\s*\d+\s*$/.test(e.text)
    if (strong) return { current: Number(m[1]), total: Number(m[2]) }
  }
  return null
}

const isLetter = (t) => /^[A-F]$/.test(t)
// 灵光里英文选项是「Bpush()」这种字母紧贴文字，所以不能用"必须带分隔符"的规则；
// 误判交给上层闸门（必须有题号进度/考试导航/问句）来挡。
const CANDIDATE = /^([A-F])\s*[.、．:：)）]?\s*(.+)$/

export function options (els) {
  // 先合并「字母单独一个元素 + 下一段是文本」的拆分布局
  const atoms = []
  for (let i = 0; i < els.length; i++) {
    const e = els[i]
    if (isLetter(e.text) && i + 1 < els.length) {
      const next = els[i + 1]
      if (!CANDIDATE.test(next.text) && next.text.length <= 80) {
        atoms.push({ text: e.text + next.text, pos: i })
        i++
        continue
      }
    }
    atoms.push({ text: e.text, pos: i })
  }

  const found = []
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const last = found.length ? found[found.length - 1].pos : -1
    const hit = atoms.find((a, i) => a.pos > last && (() => {
      const m = a.text.match(CANDIDATE)
      return m && m[1] === letter && m[2].trim().length >= 1
    })())
    if (!hit) break
    const m = hit.text.match(CANDIDATE)
    found.push({ letter, text: m[2].trim().replace(/\s+/g, ' '), pos: hit.pos })
  }
  return found.length >= 3 ? found : []   // 三选项的题也存在
}

// 题干候选的最低要求：有实义汉字、不像界面文字。宁可返回空让上层去 OCR，也不能把 UI 文字当题干。
const UI_TEXT = /显示答案|备注|单选题|多选题|判断题|做对|做错|退出考试|题目导航|进度|可上下滑|可左右滑|答题卡|交卷/
export function looksLikeQuestion (t) {
  const s = String(t || '').trim()
  if (s.length < 8) return false
  if (UI_TEXT.test(s)) return false
  if (/^\[/.test(s)) return false
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length
  return cjk >= 4
}

/** 题干：优先取以问号结尾的文本，其次取选项前一段像句子的文本。 */
export function question (els, opts) {
  const qs = els.filter((e) => e.role === '文本' && e.text.length >= 6 && /[？?]\s*$/.test(e.text))
  if (qs.length) return qs.sort((a, b) => b.text.length - a.text.length)[0].text.trim()

  if (!opts.length) return ''
  const firstPos = opts[0].pos
  for (let i = firstPos - 1; i >= 0 && i >= firstPos - 6; i--) {
    const t = els[i].text
    if (t.length >= 8 && looksLikeQuestion(t)) return t
  }
  return ''
}

/** 一屏是不是题目页。 */
export function parseScreen (dump) {
  const els = elements(dump)
  const app = appName(dump)
  const opts = options(els)
  const prog = progress(els)
  const q = question(els, opts)
  const nav = /下一题|上一题/.test(dump)
  const isQuestion = opts.length >= 3 && Boolean(q || nav)
  return { app, els, opts, prog, question: q, isQuestion }
}

/** 稳定的题目指纹：题号 + 选项原文（OCR 的题干波动不影响）。 */
export function signature (screen) {
  const parts = [screen.app]
  if (screen.prog) parts.push('#' + screen.prog.current)
  else parts.push(screen.question.replace(/[^\p{L}\p{N}]/gu, ''))
  parts.push(screen.opts.map((o) => o.letter + o.text).join('|'))
  return parts.join('\n')
}
