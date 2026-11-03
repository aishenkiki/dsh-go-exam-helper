// 通用视觉模型调用（OpenAI 兼容接口），供通义千问 / 智谱 / Kimi / 豆包 等渠道复用。
import fs from 'node:fs'

export async function askImage ({ baseURL, apiKey, model, text, imagePath, maxTokens = 2000, temperature = 0, extra = {} }) {
  const b64 = fs.readFileSync(imagePath).toString('base64')
  const ext = (imagePath.split('.').pop() || 'jpeg').toLowerCase().replace('jpg', 'jpeg')
  const res = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: `data:image/${ext};base64,` + b64 } },
        ],
      }],
      ...extra,
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const j = await res.json()
  return j.choices?.[0]?.message?.content || ''
}

export function pickAnswer (content) {
  const m = String(content).match(/"answer"\s*:\s*"([A-D])"/) || String(content).match(/(?:^|[^A-Z])([A-D])(?:[^A-Z]|$)/)
  return m ? m[1] : null
}
