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

  async function callModel (content, maxTokens = 24) {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'x-dsh-auth-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) throw new Error('model HTTP ' + r.status)
    const j = await r.json()
    return (j.choices?.[0]?.message?.content || '').trim()
  }

  async function ask (question, opts, strict, multi) {
    const text = await callModel(PROMPT(question, opts, strict, multi))
    const letters = pickLetters(text, multi)
    if (!letters) return null
    return { letter: letters, confidence: CONF(text) }
  }

  const valid = (letters, opts) => Boolean(letters) &&
    letters.split('').every((ch) => opts.some((o) => o.letter === ch))

  const answer = async function answer (sig, question, opts, multi = false) {
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

  // 题库命中了，但答案文字在屏幕选项里找不到完全一致的项（考试端改了措辞）。
  // 这时不要整题退化成"重新作答"，而是让模型只做一件事：在现有选项里挑与标准答案同义的那一项。
  answer.pick = async function pick (sig, question, opts, target) {
    const key = sig + ':pick'
    const hit = cache[key]
    if (hit && valid(hit.letter, opts)) return hit.letter
    const text = await callModel(
      `题库里这道题的标准答案是「${target}」。下面选项的措辞可能和题库不完全一样，请选出与它意思相同的**一项**。` +
      `只输出一个字母（A/B/C/D/E/F），不要解释。\n\n题目：${question}\n${fmtOpts(opts)}`, 8)
    const letter = pickLetters(text, false)
    if (!valid(letter, opts)) return null
    cache[key] = { letter, confidence: 'high', question: question.slice(0, 80), at: Date.now() }
    save()
    return letter
  }

  return answer
}
