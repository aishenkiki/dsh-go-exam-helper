// 统一答题出口：强制格式 + 解析兜底 + 失败重问。
// 之前的教训：模型不是答错，而是「没按格式给字母」，所以格式要在代码里兜住，不能指望模型。

const SPEC = `输出格式（必须严格遵守）：
只输出一行 JSON，不要输出任何解释、步骤、代码块或多余标点：
{"answer":"X"}
其中 X 只能是 A、B、C、D 中的一个字母。`

export function parseAnswer (text) {
  if (!text) return null
  const t = String(text)
  const json = t.match(/\{"?\s*answer"?\s*:\s*"([A-D])"/i)
  if (json) return json[1].toUpperCase()
  const line = t.match(/答案\s*[:：]?\s*([A-D])\b/)
  if (line) return line[1].toUpperCase()
  const only = t.trim().match(/^([A-D])$/)
  if (only) return only[1]
  const tail = t.trim().match(/(?:^|[\s，。:：])([A-D])[\s。.．]*$/)
  if (tail) return tail[1]
  return null
}

export async function solve (client, prompt, { model = 'deepseek-chat', maxTokens = 1200 } = {}) {
  const attempts = []
  for (let i = 0; i < 2; i++) {
    const content = i === 0 ? `${prompt}\n\n${SPEC}` : `${prompt}\n\n不要分析，直接给结果。${SPEC}`
    let text = ''
    try {
      text = await client(model, content, maxTokens)
    } catch (e) {
      attempts.push({ error: e.message })
      continue
    }
    const answer = parseAnswer(text)
    attempts.push({ answer, chars: text.length })
    if (answer) return { answer, attempts, text }
  }
  return { answer: null, attempts, text: '' }
}
