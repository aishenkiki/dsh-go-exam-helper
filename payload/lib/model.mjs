// 调模型答题：固定温度、强制单字母、按题目指纹缓存（同一题永远同一答案）。
import fs from 'node:fs'

const fmtOpts = (opts) => opts.map((o) => `${o.letter}. ${o.text}`).join('\n')

const PROMPT = (q, opts, strict, multi) => {
  if (strict) return `只输出字母，不要解释：\n${q}\n${fmtOpts(opts)}`
  if (multi) {
    return `这是多选题，正确选项可能不止一个。只输出一行 JSON，不要解释：\n{"answer":"AC","confidence":"high"}\n` +
      `answer 写所有正确选项的字母（如 "AC"）；confidence 是 "high" 或 "low"，不确定就写 low。\n\n` +
      `题目：${q}\n${fmtOpts(opts)}`
  }
  return `这是单选题，四个选项里必须选一个。只输出一行 JSON，不要解释：\n{"answer":"X","confidence":"high"}\n` +
    `X 是 A/B/C/D 之一；confidence 是 "high" 或 "low"，你不确定就写 low。\n\n` +
    `题目：${q}\n${fmtOpts(opts)}`
}

/** 从模型输出里抠出字母；多选题返回排序去重后的多字母串（如 "AC"） */
function pickLetters (text, multi) {
  const j = text.match(/\{[\s\S]*\}/)
  if (j) {
    try {
      const v = String(JSON.parse(j[0]).answer || '').toUpperCase().replace(/[^A-F]/g, '')
      if (v) return multi ? [...new Set(v.split(''))].sort().join('') : v[0]
    } catch {}
  }
  if (multi) {
    const all = [...new Set((text.match(/[A-F]/g) || []))].sort()
    return all.join('')
  }
  const m = text.match(/(?:^|[^A-Za-z])([A-F])(?=$|[^A-Za-z])/)
  return m ? m[1] : ''
}

const CONF = (text) => (/\"confidence\"\s*:\s*\"low\"/i.test(text) ? 'low' : 'high')

export function createAnswerer ({ token, cacheFile, log = () => {} }) {
  let cache = {}
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch {}
  let timer = null
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache)) } catch {}
    }, 500)
  }

  async function ask (question, opts, strict, multi) {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'x-dsh-auth-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: 24,
        messages: [{ role: 'user', content: PROMPT(question, opts, strict, multi) }],
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) throw new Error('model HTTP ' + r.status)
    const j = await r.json()
    const text = (j.choices?.[0]?.message?.content || '').trim()
    const letters = pickLetters(text, multi)
    if (!letters) return null
    return { letter: letters, confidence: CONF(text) }
  }

  const valid = (letters, opts) => Boolean(letters) &&
    letters.split('').every((ch) => opts.some((o) => o.letter === ch))

  return async function answer (sig, question, opts, multi = false) {
    const hit = cache[sig]
    if (hit && valid(hit.letter, opts)) {
      log('缓存', hit.letter)
      return { letter: hit.letter, confidence: hit.confidence || 'high' }
    }
    let got = await ask(question, opts, false, multi)
    if (!got) got = await ask(question, opts, true, multi)
    if (got && valid(got.letter, opts)) {
      cache[sig] = { letter: got.letter, confidence: got.confidence, question: question.slice(0, 80), at: Date.now() }
      save()
      return got
    }
    return null
  }
}
