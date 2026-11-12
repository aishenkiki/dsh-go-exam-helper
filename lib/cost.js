// 读 dsh-cost-meter 的账本，给原生面板提供数据（只读，不写）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LEDGER = process.env.DSH_COST_LEDGER ||
  path.join(os.homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json')

/** 本地时区的 YYYY-MM-DD（账本按本地日期分桶）。 */
export function dayKey (d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function money (v, symbol = '¥') {
  const n = Number(v) || 0
  if (n === 0) return `${symbol}0`
  if (n < 0.01) return `${symbol}${n.toFixed(4)}`
  if (n < 1000) return `${symbol}${n.toFixed(2)}`
  return `${symbol}${Math.round(n).toLocaleString('en-US')}`
}

const shortModel = (key) => {
  const s = String(key || '')
  const tail = s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s
  return tail.replace(/^deepseek-/, '').replace(/-account$/, '') || s
}

const tokens = (row) => {
  const n = (Number(row.input) || 0) + (Number(row.output) || 0) + (Number(row.cacheRead) || 0)
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}

/**
 * 汇总面板要用的数字。读不到账本时返回 null（面板显示"未安装费用插件"）。
 * sessionId 来自 scope，形如 uuid；账本里是 session-<uuid>。
 */
export function readCost (sessionId) {
  let j
  try { j = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) } catch { return null }
  const symbol = (j.config && j.config.symbol) || '¥'
  const today = dayKey(new Date())
  const days = j.days && typeof j.days === 'object' ? j.days : {}
  const t = days[today] || null

  // 本会话：今天的 sessions 里按 id 找（可能是 session-<uuid> 或裸 uuid）
  let mine = null
  if (t && Array.isArray(t.sessions) && sessionId) {
    mine = t.sessions.find((s) => s && (s.id === sessionId || s.id === `session-${sessionId}` ||
      String(s.id).endsWith(sessionId))) || null
  }

  // 近 7 天（按日期升序，只取有记录的）
  const recent = Object.keys(days).sort().slice(-7).map((k) => {
    const d = days[k] || {}
    return { date: k, label: k.slice(5), cost: Number(d.costCny) || 0, calls: Number(d.calls) || 0 }
  })

  // 今日按模型排行
  const models = Object.entries((t && t.byProviderModel) || {})
    .map(([k, v]) => ({ name: shortModel(k), cost: Number(v.costCny) || 0, tokens: tokens(v), calls: Number(v.calls) || 0 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)

  const bal = j.balanceRef && Number(j.balanceRef.total) ? j.balanceRef : null

  return {
    symbol,
    today: today === (t && t.date) ? today : today,
    todayCost: Number(t && t.costCny) || 0,
    todayCalls: Number(t && t.calls) || 0,
    todayTokens: tokens(t || {}),
    sessionCost: Number(mine && mine.costCny) || 0,
    sessionCalls: Number(mine && mine.calls) || 0,
    sessionTokens: mine ? tokens(mine) : '',
    hasSession: !!mine,
    recent,
    models,
    balance: bal ? { total: Number(bal.total), date: bal.date, currency: bal.currency || 'CNY' } : null,
  }
}
