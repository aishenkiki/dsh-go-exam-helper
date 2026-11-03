import { execFile } from 'node:child_process'

// 视觉读题：把截图直接交给多模态模型，一次拿到题干、选项和答案。
// 相比 OCR：不依赖字体、分辨率、版面、字母标记，换任何 App / 网页都成立。
const PROMPT = `这是一张手机截图，里面可能是一道选择题。
请读出题干和选项原文，并给出正确答案。

只输出 JSON，不要解释：
{"question":"题干原文","options":["选项A原文","选项B原文","选项C原文","选项D原文"],"answer":"A","confidence":"high"}

要求：
- 题干和选项照抄截图里的文字，不要改写、不要翻译；
- 选项按截图中从上到下的顺序，只写内容，不要带 "A." 这类序号；
- answer 只能是 A/B/C/D/E/F 中的一个字母；题目没有问号也照常作答；
- confidence 是 "high" 或 "low"：截图文字看不清、或这题靠猜，就写 low；
- 如果截图里不是选择题，输出 {"question":""}。`

// 纯图形推理题：截图里没有可抄的文字，让它抄题干只会得到空结果，所以单独一条提示词
const GRAPHIC_PROMPT = `这是一张图形推理题的截图：上面是题干图形序列（最后一个问号处是要找的图形），下面是 A B C D 四个选项图形。
请找出图形变化的规律，选出符合规律的一项。

只输出一行 JSON，不要解释格式之外的内容：
{"answer":"A","reason":"一句话说明规律","confidence":"high"}
- answer 只能是 A/B/C/D 之一；
- confidence 是 "high" 或 "low"，看不出规律就写 low。`

function parseJson (text) {
  if (!text) return null
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}

const SHRINK = `
import sys
from PIL import Image
src, dst, maxw = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
if im.width > maxw:
    im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(dst, quality=85)
    print(dst)
else:
    print(src)
`

/** 发送前缩到 760px 宽：图片 token 从 ~960 降到 ~370，实测转录文字不变。 */
function shrink (jpgPath, fs, maxw = 760) {
  return new Promise((resolve) => {
    const dst = jpgPath.replace(/\.jpg$/, '-send.jpg')
    execFile('/usr/bin/python3', ['-c', SHRINK, jpgPath, dst, String(maxw)], { timeout: 15000 }, (e, out) => {
      const p = (out || '').trim()
      resolve(p && fs.existsSync(p) ? p : jpgPath)
    })
  })
}

export async function readAndAnswer (jpgPath, { token, fetchImpl = fetch, fs, multi = false, graphic = false }) {
  const sendPath = await shrink(jpgPath, fs)
  const b64 = fs.readFileSync(sendPath).toString('base64')
  const r = await fetchImpl('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'x-dsh-auth-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: graphic
            ? GRAPHIC_PROMPT
            : multi
              ? PROMPT + '\n- 这是多选题：answer 写所有正确选项的字母，如 "AC"（不要空格、不要逗号）。'
              : PROMPT },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) throw new Error('vision HTTP ' + r.status)
  const j = await r.json()
  const msg = j.choices?.[0]?.message || {}
  const data = parseJson(msg.content || '')
  if (graphic) {
    const g = String(data?.answer || '').toUpperCase().replace(/[^A-F]/g, '')
    if (!g) return null
    return {
      question: '',
      options: [],
      answer: g[0],
      confidence: /"confidence"\s*:\s*"low"/i.test(msg.content || '') ? 'low' : 'high',
      reason: String(data?.reason || ''),
    }
  }
  if (!data || !data.question || !Array.isArray(data.options) || data.options.length < 2) return null
  const raw = String(data.answer || '').toUpperCase().replace(/[^A-F]/g, '')
  if (!raw) return null
  const letters = [...new Set(raw.split(''))].sort()
  if (letters.some((ch) => Number(ch.charCodeAt(0)) - 65 >= data.options.length)) return null
  return {
    question: String(data.question).trim(),
    options: data.options.map((t, i) => ({ letter: 'ABCDEF'[i], text: String(t).trim() })),
    answer: multi ? letters.join('') : letters[0],
    confidence: /"confidence"\s*:\s*"low"/i.test(msg.content || '') ? 'low' : 'high',
  }
}
