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
    const after = atoms.filter((a) => a.pos > last)
    const hit = after.find((a) => {
      const m = a.text.match(CANDIDATE)
      return m && m[1] === letter && m[2].trim().length >= 1
    })
    if (hit) {
      const m = hit.text.match(CANDIDATE)
      found.push({ letter, text: m[2].trim().replace(/\s+/g, ' '), pos: hit.pos })
      continue
    }
    // 已经选中的那一项，字母会被 ✓/check_circle 顶掉（"✓在相同的银行风险条件下…check_circle"），
    // 于是整道题因为少一个字母而认不出来。这里按位置把它补回来。
    const sel = letter === 'A'
      ? null
      : after.find((a) => /check_circle|[✓✔√]/.test(a.text) && !UI_TEXT.test(a.text) && a.text.replace(/check_circle|[✓✔√]/g, '').trim().length >= 1)
    if (!sel) break
    found.push({ letter, text: sel.text.replace(/check_circle|[✓✔√]/g, '').trim().replace(/\s+/g, ' '), pos: sel.pos })
  }
  return found.length >= 3 ? found : judgeOptions(els)
}

// 判断题：界面上只有「错误 / 正确」两个圆圈，没有 A-F 字母，按出现顺序配成 A/B。
const JUDGE_TEXT = /^(正确|错误|对|错|是|否|√|×|✔|✘|☑|☒)$/
function judgeOptions (els) {
  const pair = []
  for (let i = 0; i < els.length && pair.length < 2; i++) {
    const raw = String(els[i].text || '').trim().replace(/\s+/g, '')
    if (!JUDGE_TEXT.test(raw)) continue
    const text = /正确|对|是|√|✔|☑/.test(raw) ? '正确' : '错误'
    if (pair.some((x) => x.text === text)) continue
    pair.push({ text, pos: i })
  }
  if (pair.length !== 2) return []
  return pair.map((x, i) => ({ letter: i ? 'B' : 'A', text: x.text, pos: x.pos }))
}

// 题干候选的最低要求：有实义汉字、不像界面文字。宁可返回空让上层去 OCR，也不能把 UI 文字当题干。
const UI_TEXT = /显示答案|备注|单选题|多选题|判断题|做对|做错|退出考试|题目导航|进度|可上下滑|可左右滑|答题卡|交卷/
export function looksLikeQuestion (t) {
  const s = String(t || '').trim()
  if (s.length < 8) return false
  // 「第9题(判断题)、…」把题型写进了题干，剥掉题型词再判断界面文字
  const core = s.replace(/单选题|多选题|判断题/g, '')
  if (UI_TEXT.test(core)) return false
  if (/^\[/.test(core)) return false
  // 无障碍会把「进度 6 / 2323」「radio_button_checked」「…截断」也算成文本，这些不是题干
  if (/\b\d{1,4}\s*\/\s*\d{3,5}\b/.test(core)) return false
  if (/[a-z]+_[a-z_]+/.test(core)) return false
  if (/[·…]\s*$/.test(core)) return false
  const cjk = (core.match(/[\u4e00-\u9fa5]/g) || []).length
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
  const judge = /判断题/.test(dump)
  const isQuestion = (opts.length >= 3 || (judge && opts.length === 2)) && Boolean(q || nav)
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

/**
 * 桥接读屏返回的是错误文本时，判断它属于哪一类：
 * - 'secure'：安全窗口 / FLAG_SECURE（银行、密码、防截屏页）——会话还活着，只是这一屏不让读
 * - 'session'：手机操控会话被停（息屏、切后台、用户点了停）
 * - 'permission'：没有无障碍/读屏权限
 * - null：不是错误
 */
export function classifyScreenError (text) {
  const t = String(text || '')
  if (!t) return null
  // 真正的安全窗口回复很短（"屏幕 s5841\n安全窗口（禁止截屏 / 读取）。"）；
  // 整屏无障碍树里出现"安全窗口"多半是用户聊天/页面里恰好提到这几个字，不能当依据。
  const short = t.length < 400
  if (short && /安全窗口|禁止截屏|禁止读取|secure window|FLAG_SECURE/i.test(t)) return 'secure'
  if (/已停止本次手机操作|屏幕关闭|手机操控.{0,6}(已)?(停止|断开)/.test(t)) return 'session'
  if (/没有权限|无权限|not allowed|permission/i.test(t)) return 'permission'
  if (short && /没有读取这个屏幕的内容/.test(t)) return 'secure' // 旧版桥接对安全窗口的说法
  return null
}
