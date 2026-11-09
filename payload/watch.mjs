// 考试助手 v4：盯屏 → 认题 → 答题 → 顶部横幅。
// 设计要点：
//   1. 只认「四个选项按顺序出现」的页面，别的界面一律不动；
//   2. 题目指纹 = 题号 + 选项原文，OCR 抖动不会造成重复弹；
//   3. 同一指纹稳定两拍才作答，避免翻页瞬间误判；
//   4. 答案按指纹缓存，同一题永远同一个答案，重进也不重算；
//   5. 单实例锁，杜绝多份进程抢同一块屏幕。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { connect } from './phone.mjs'
import { parseScreen, signature, looksLikeQuestion, classifyScreenError } from './lib/parse.mjs'
import { createAnswerer } from './lib/model.mjs'
import { analyze, analyzeFast } from './lib/pipeline.mjs'
import { readAndAnswer } from './lib/vision.mjs'
import { loadBank, norm } from './lib/bank.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
// 锁必须放在部署目录之外：升级时整目录会被改名，目录内的 pid 文件会跟着走，
// 新进程看不到旧进程，就会出现两个 watcher 同时抢屏、同一题弹两遍。
const LOCK = process.env.DSH_EXAM_LOCK || path.join(os.homedir(), '.dsh', 'exam-helper-watch.pid')
const LOG = DIR + '/watch.log'
const MIN_STABLE = 2
let bank = loadBank(DIR) // 有 bank.json 就先查表；文件换了会自动重载

// 题库里的答案字母对应题库自己的选项顺序；App 上的选项顺序可能不同，必须按文字重新对位。
// 对不上就说明这条题库记录和屏幕上的题不是同一版，宁可放弃也不能弹错。
function bankLetter (hit, opts) {
  const target = norm(hit.text)
  if (!target || !opts || !opts.length) return hit.answer
  for (const o of opts) {
    const t = norm(o.text)
    if (t && (t === target || t.includes(target) || target.includes(t))) return o.letter
  }
  return null
}

async function tryBank (question, opts, key) {
  bank = loadBank(DIR) // 每拍 stat 一次，题库导入后立刻生效
  if (!bank || !question) return null
  const hit = bank.lookup(question, opts)
  if (!hit) return null
  const letter = bankLetter(hit, opts)
  if (letter) return { ...hit, answer: letter }
  // 屏幕上找不到与题库答案完全相同的措辞（考试端改写了选项文字）：
  // 让模型只做"把标准答案对到某一项"这一件事，比让它重新答一遍更可靠。
  const mapped = await answer.pick(key || signature(question, opts), question, opts, hit.text)
  if (!mapped) return null
  return { ...hit, answer: mapped, match: hit.match + '+对位' }
}

const LOG_MAX = 2 * 1024 * 1024
let logWrites = 0
let lastErrMsg = ''
let lastErrAt = 0
let errRepeat = 0

// 日志超过 2 MB 就轮转成 watch.log.1（只留一代），长时间监考不会把盘写满。
function rotateIfNeeded () {
  try {
    if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, LOG + '.1')
  } catch {}
}

// 长期使用会攒下大量截图（每题一张），旧的对诊断没用了：只留最近的几张。
// 日志本身不用担心：watch.log + watch.log.1 两个文件封顶 4 MB。
const CORPUS_KEEP = 200
const FAIL_KEEP = 60
function pruneOld (dir, keep, filter) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => filter(f))
      .map((f) => ({ f, t: fs.statSync(dir + '/' + f).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) {
      try { fs.unlinkSync(dir + '/' + f) } catch {}
    }
  } catch {}
}
pruneOld(DIR + '/corpus/auto', CORPUS_KEEP, () => true)
pruneOld(DIR, FAIL_KEEP * 2, (f) => /^fail-/.test(f))

const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.join(' ')
  try {
    fs.appendFileSync(LOG, line + '\n')
    logWrites += 1
    if (logWrites % 500 === 0) rotateIfNeeded()

  } catch {}
}

// 同类错误 30 秒内只记一条，避免断线时把日志刷爆。
function logErr (msg) {
  const now = Date.now()
  if (msg === lastErrMsg && now - lastErrAt < 30000) { errRepeat += 1; return }
  log('ERR', msg, errRepeat > 0 ? `(同类又 ${errRepeat} 次)` : '')
  lastErrMsg = msg
  lastErrAt = now
  errRepeat = 0
}

rotateIfNeeded()

// pid 会被系统复用：只有命令行里确实有 watch.mjs 才算是我们的旧实例。
function isWatcherPid (pid) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
  }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
    return /watch\.mjs/.test(cmd)
  } catch {
    return true // 读不到 /proc 时保守当成活着的
  }
}

function takeLock () {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'))
    if (pid && pid !== process.pid) {
      const alive = isWatcherPid(pid)
      if (alive) {
        console.error('已有实例在跑：' + pid)
        process.exit(0)
      }
    }
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid))
}

function releaseLock () {
  try {
    if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK)
  } catch {}
}

function withTimeout (p, ms, what) {
  let timer
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(what + ' 超时')), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

// 凭据：优先用环境变量，其次读 DSH 的凭据文件。换设备/没登录时不能直接崩掉。
function readToken () {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    '/root/.dsh/.credentials.yaml',
  ]
  for (const f of candidates) {
    try {
      const text = fs.readFileSync(f, 'utf8')
      const m = text.match(/deepseek-account-platform\/default:[\s\S]*?token:\s*(\S+)/)
      if (m) return m[1]
    } catch {}
  }
  return null
}
const token = readToken()
if (!token) {
  log('没有可用的模型凭据：请在 DSH 设置 → 模型里登录，或设置环境变量 DSH_TOKEN')
  console.error('没有可用的模型凭据')
  process.exit(2)
}

takeLock()
process.on('exit', releaseLock)
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
process.on('SIGINT', () => { releaseLock(); process.exit(0) })

const answer = createAnswerer({ token, cacheFile: DIR + '/answers.json', log })

// done: 已答题 → 最后一次弹通知的时间（毫秒）
const state = { examSeen: false, sig: '', stable: 0, screen: null, attempts: new Map(), lastRejected: '', lastApp: '', lastAt: 0, ocrProg: 0, shownSig: '', faultNotified: false, faultTimes: [], lastExamAt: 0, secure: false, secureSince: 0, secureNotified: false, shownAt: 0, hbAt: 0 }

async function shoot (p) {
  const r = await withTimeout(p.callTool('screen', { image: true }), 8000, '截图')
  const img = (r.images || [])[0]
  if (!img || !img.data) return null
  const file = DIR + '/shot.jpg'
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'))
  return file
}


// 读屏被掐断的状态：只在开始时提醒一次，别刷屏
function noteReadFault (why) {
  const first = !state.fault
  state.fault = true
  if (first) log('读屏被系统停止', String(why || '').slice(0, 40))
  // 同一次中断只提醒一次；恢复后再次中断才会重新计数（以前每 120 秒重发，通知栏会攒一堆一样的）
  if (state.faultNotified) return
  const now = Date.now()
  state.faultTimes = (state.faultTimes || []).filter((t) => now - t < 3600_000)
  if (state.faultTimes.length >= 3) return // 一小时最多 3 条，剩下的只写日志
  state.faultNotified = true
  state.faultTimes.push(now)
  state.faultAt = now
  if (pc) pc.callTool('notify', { title: '答题助手：读屏停了', text: '打开 设置→手机操控 关一下再打开（或对我说一句“读一下屏幕”），再回考试页' }).catch(() => {})
}

function clearReadFault () {
  if (!state.fault) return
  state.fault = false
  state.faultAt = 0
  state.faultNotified = false // 下次中断可以再提醒一次
  log('读屏恢复')
}

async function tick (p) {
  const t0 = Date.now()
  state.ocrProg = 0
  const r = await withTimeout(p.callTool('screen', {}), 6000, '读屏')
  const dump = r.text || ''
  // 手机操控会话被系统断掉（息屏、切后台、用户点了停）时，桥接返回 isError 而不是抛错，
  // 这时候要明确告诉用户，否则看起来就是"不动了"。
  // FLAG_SECURE / 安全窗口：这一屏系统禁止读取（银行、密码、考试系统的防截屏页），
  // 但手机操控会话还活着、小圆球也还在 —— 不能当"读屏停了"去打扰用户。
  // DSH 自己的界面直接在 App 内读，不走桥接；桥接拒绝时返回的也是短文本，
  // 先认出"这是 DSH"，不要误判成安全窗口。
  if (/· DSH Go ·/.test(dump) && dump.length > 400) {
    clearReadFault()
    state.secure = false
    state.sig = ''
    state.stable = 0
    return
  }
  const errKind = classifyScreenError(dump)
  if (errKind === 'secure') {
    // 这一屏系统禁止读取（银行/密码/防截屏页），但手机操控会话还在，小圆球也还在 —— 跳过即可，别报警。
    if (state.secure !== true) {
      state.secure = true
      state.secureSince = Date.now()
      state.secureNotified = false
      log('安全页面，暂时跳过', String(dump).replace(/\s+/g, ' ').slice(0, 40))
    }
    // 考试中途遇到防截屏页：静止 3 秒后提示一次，让用户知道是页面不让读，而不是插件坏了。
    // 只在最近 10 分钟内读过题时才提示，避免平时刷银行 App 也被打扰。
    const examRecently = state.lastExamAt && Date.now() - state.lastExamAt < 10 * 60 * 1000
    if (!state.secureNotified && examRecently && Date.now() - state.secureSince > 3000) {
      state.secureNotified = true
      log('安全窗口提示已发')
      try {
        await pc.callTool('notify', {
          title: '答题助手：这页禁止读取',
          text: '这一页有防截屏保护，我看不到题目。换网页版，或把题干复制给我。',
        })
      } catch (e) { log('提示发送失败', e.message) }
    }
    clearReadFault()
    state.sig = ''
    state.stable = 0
    return
  }
  state.secure = false
  state.secureSince = 0
  state.secureNotified = false
  if (errKind === 'session' || errKind === 'permission' || (r.raw && r.raw.isError)) {
    noteReadFault(dump)
    return
  }
  clearReadFault()
  if (!dump || /DSH 自己的界面/.test(dump) || /· DSH Go ·/.test(dump)) { state.sig = ''; state.stable = 0; return }

  let screen = parseScreen(dump)

  // 同一 App 刚才还能认出题、这一屏却认不出（无障碍结构变了/被折叠了）：
  // 给它一次纯 OCR 的机会，避免因为界面结构变化就整段失效。
  if (!screen.isQuestion && screen.app && screen.app === state.lastApp && Date.now() - state.lastAt < 5 * 60_000) {
    const shot = await shoot(p)
    const got = shot ? await analyze(shot, []) : null
    const judgeScreen = /判断题/.test(dump)
    if (got && !got.weak && got.question.length >= 8 && got.options.length >= (judgeScreen ? 2 : 3)) {
      screen = { ...screen, isQuestion: true, question: got.question, opts: got.options }
      log('OCR 兜底', got.how, got.question.slice(0, 24))
    }
  }

  // 是不是「题目页」：认得出题，并且页面像个答题界面。
  // 不限 App——正式考试可能是浏览器网页、微信扫开的 H5、或小程序，所以只认界面特征：
  // 有题号进度 / 有考试导航按钮 / 题干是问句。三样都没有就不动手。
  // 诊断用：题目页但无障碍没给出题干时，把原始屏读存一份，用来确认题干到底在不在无障碍树里
  if (screen.isQuestion && !screen.question) {
    try { fs.writeFileSync(DIR + '/debug-noq.txt', dump) } catch {}
  }
  const NAV = /下一题|上一题|答题卡|单选题|多选题|判断题|提交试卷|交卷/
  const examish = screen.isQuestion &&
    (!!screen.prog || NAV.test(dump) || /[？?]\s*$/.test(screen.question || ''))
  const multi = MULTI.test(dump)   // 多选题：模型要给出多个字母
  state.examSeen = examish
  if (examish) state.lastExamAt = Date.now()
  if (!examish) {
    state.sig = ''
    state.stable = 0
    return
  }

  // 每 20 秒留一条心跳：不管认没认成题目页都记一笔，出问题时能看出它到底看到了什么
  if (Date.now() - (state.hbAt || 0) > 20000) {
    state.hbAt = Date.now()
    log('心跳', screen.app || '?',
      '题目页=' + (screen.isQuestion ? '是' : '否'),
      '题号=' + (screen.prog ? screen.prog.current : state.ocrProg || '?'),
      '选项=' + (screen.opts ? screen.opts.length : 0),
      '题干' + ((screen.question || '').length) + '字')
  }

  const sig = screen.isQuestion
    ? signature(screen)
    : 'app:' + screen.app + ':q' + (screen.prog ? screen.prog.current : '?')

  if (sig !== state.sig) {
    state.sig = sig
    state.attempts.delete(sig)   // 每次重新进入这道题都重新给两次机会，否则切几次后就再也不弹了
    state.stable = 1
    state.screen = screen
    return                       // 等下一拍确认稳定
  }
  state.stable++
  // 有题号进度说明是正规答题页，题号+选项一起变就是换题了，等一拍就够（省 0.9 秒）；
  // 没有题号的页面保守一点，等两拍，避免拍到过渡动画。
  if (state.stable < (screen.prog ? 1 : MIN_STABLE)) return


  // 还停在同一题上不重复弹；但超过 8 秒又看到同一题，说明中间翻走又回来了（可能没拍到中间那题），要重弹
  if (sig === state.shownSig && Date.now() - state.shownAt < 8000) return
  // 同一题最多连续试两次，避免失败时狂刷；但"停下来一段时间再回来看同一题"要重新给机会，
  // 否则像"选了选项再切回来"这种签名没变的情况会被永久挡住。
  const att = state.attempts.get(sig)
  const tries = att && Date.now() - att.at < 10000 ? att.n : 0
  if (tries >= 2) { state.lastRejected === sig || log('跳过', sig.slice(0, 6), '连续试过' + tries + '次'); state.lastRejected = sig; return }
  state.attempts.set(sig, { n: tries + 1, at: Date.now() })

  let graphicReason = ''
  let question = screen.question
  let opts = screen.opts
  let letter = null
  let conf = 'high'
  let ocrMs = 0        // 慢路各阶段耗时，写进日志用
  let visionMs = 0
  let tOcr = 0
  let fromBank = null                     // 命中题库时记下来，标题加 📚、正文标「题库：」

  const cKey = createHash('sha1')
    .update(question + '|' + opts.map((o) => o.letter + o.text).join('|'))
    .digest('hex').slice(0, 12)

  // 第 0 步：题库查表（官方答案，比模型准，也不花钱）
  if (question) {
    fromBank = await tryBank(question, opts, cKey)
    if (fromBank) {
      letter = fromBank.answer
      conf = 'high'
      log('题库', fromBank.match, letter, question.slice(0, 24))
    }
  }

  // 快路：无障碍里题干和选项都齐全，直接用文字模型（快、准、不花图片钱）
  if (!letter && question && opts.length >= 3 && looksLikeQuestion(question)) {
    // 选项是图片时文字模型没法答，交给下面的视觉路
    if (!blankOpts(opts)) {
      const a = await answer(cKey, question, opts, multi)
      if (a) { letter = a.letter; conf = a.confidence }
    }
  }

  // 慢路：读不全就截图交给多模态模型，一次拿全（题干/选项/答案）
  if (!letter) {
    const shot = await shoot(p)
    if (!shot) { log('截图失败', sig.slice(0, 6)); return }

    // 先本地 OCR 一次（约 0.8 秒）拿题干查题库：命中就不用调视觉模型，省约 1 秒和一次调用费。
    // 查表本身还有相似度阈值和选项对位把关，OCR 认错字最多导致不命中，不会导致弹错。
    state.ocrProg = 0 // 每拍重算，别把上一题的题号带到这一题
    tOcr = Date.now()
    const quick = await analyzeFast(shot, screen.opts)
    ocrMs = Date.now() - tOcr
    if (quick && quick.prog) state.ocrProg = quick.prog.current
    if (quick && quick.ok) {
      const qOpts = screen.opts.length >= 3 ? screen.opts : quick.options
      fromBank = await tryBank(quick.question, qOpts, cKey)
      // 长题干只取后 3 行，开头常被丢掉：用多收两行的备选再查一次
      if (!fromBank && quick.questionAlt) fromBank = await tryBank(quick.questionAlt, qOpts, cKey)
      if (fromBank) {
        opts = qOpts
        letter = fromBank.answer
        conf = 'high'
        log('题库-fast', fromBank.match, letter, quick.question.slice(0, 24))
      }
    }
    // 图形题：题干和选项都不是文字（或要描述图形），普通"抄题干"提示词只会返回空，得走专用提示词
    const noText = !question || !looksLikeQuestion(question)
    const isGraphic = GRAPHIC.test(question || '') || (noText && (blankOpts(screen.opts) || screen.opts.length === 0))

    let v = null
    const tV = Date.now()
    if (!letter) {
      try {
        v = await readAndAnswer(shot, { token, fs, multi, graphic: isGraphic })
      } catch (e) { log('视觉失败', e.message) }
    }
    visionMs = Date.now() - tV

    if (letter) {
      // 题库已答，不再看视觉结果（也根本没调）
    } else if (v) {
      question = v.question
      opts = v.options
      fromBank = await tryBank(question, opts, cKey)
      if (fromBank) {
        letter = fromBank.answer
        conf = 'high'
        log('题库', fromBank.match, letter, question.slice(0, 24))
      }
      if (!letter) {
        letter = v.answer
        conf = v.confidence || 'high'
        if (v.reason) graphicReason = v.reason
      }
      log('视觉', question.slice(0, 26), letter, conf === 'low' ? '(存疑)' : '')
      try {
        fs.mkdirSync(DIR + '/corpus/auto', { recursive: true })
        const name = String(Date.now()).slice(-7)
        fs.copyFileSync(shot, DIR + '/corpus/auto/' + name + '.jpg')
        fs.writeFileSync(DIR + '/corpus/auto/' + name + '.json',
          JSON.stringify({ question, options: opts, answer: letter, how: 'vision' }))
      } catch {}
    } else {
      // 视觉也不行，才退回多候选 OCR 版面分析（这一步要多花约 1.5 秒，所以放在视觉之后）
      const got = await analyze(shot, screen.opts)
      if (!got || got.weak) {
        const tag = String(Date.now()).slice(-7)
        try { fs.copyFileSync(shot, DIR + '/fail-' + tag + '.jpg') } catch {}
        try { fs.copyFileSync(shot.replace(/\.jpg$/, '-ocr.txt'), DIR + '/fail-' + tag + '.txt') } catch {}
        log('切不出题干', sig.slice(0, 6), got ? '分数' + got.score : '', '→ fail-' + tag)
        return
      }
      question = got.question
      if (got.prog && got.prog.current && !state.ocrProg) state.ocrProg = got.prog.current
      opts = screen.opts.length >= 3 ? screen.opts : got.options
      log('OCR', got.score, got.how, question.slice(0, 24))
      fromBank = await tryBank(question, opts, cKey)
      if (fromBank) {
        letter = fromBank.answer
        conf = 'high'
        log('题库', fromBank.match, letter, question.slice(0, 24))
      }
      if (!letter) {
        const a2 = await answer(cKey, question, opts, multi)
        if (a2) { letter = a2.letter; conf = a2.confidence }
      }
    }
  }

  // 答不出来也要说一声：什么都不弹的话，用户会以为助手卡住了，一直干等。
  if (!letter) {
    log('没拿到答案', sig.slice(0, 6))
    if (sig !== state.shownSig) {
      const no0 = (screen.prog && screen.prog.current) || state.ocrProg || '?'
      await p.callTool('notify', { title: `第 ${no0} 题 · 没把握`, text: '这题没答出来，先自己判断' })
      state.shownSig = sig
      state.shownAt = Date.now()
      state.lastAt = Date.now()
      log('未答', `第 ${no0} 题`, '（已提示用户）')
    }
    return
  }

  // 同一道题（题干+选项相同）只答一次，且永远用同一个答案
  if (sig === state.shownSig) return

  const picked = opts.filter((o) => String(letter).includes(o.letter))
  const no = (screen.prog && screen.prog.current) || state.ocrProg || '?'
  const doubt = conf === 'low'
  const title = `第 ${no} 题 · ${fromBank ? '📚 ' : ''}${letter}${doubt ? '?' : ''}`
  const body = Array.from(picked.map((o) => o.text).join('；') || graphicReason || '').slice(0, 60).join('')
  const text = fromBank ? `题库：${body}` : doubt ? `存疑：${body}` : body
  await p.callTool('notify', { title, text })
  state.shownSig = sig
  state.shownAt = Date.now()
  state.lastApp = screen.app
  state.lastAt = Date.now()
  log('作答', title, body, '|', question.slice(0, 30), doubt ? '| 存疑' : fromBank ? '| 题库' : '',
    '| ' + (Date.now() - t0) + 'ms', '| ocr ' + ocrMs + ' vision ' + visionMs + 'ms')
}

const MULTI = /多选题/
const GRAPHIC = /图形|九宫格|问号处|折叠|展开图|截面|拼图|数图形/
const blankOpts = (opts) => opts.length >= 3 && opts.every((o) => !(o.text || '').trim())

log('watcher 启动 v4 · pid ' + process.pid)
log('题库', bank ? bank.size + ' 题' : '未加载（放 bank.json 到目录里即可）')

// 桥接的 socket 名每次引擎启动都会变；连接断了要重读配置重连，否则会变成只刷 ERR 的僵尸进程。
const isConnError = (msg) => /closed|ECONNREFUSED|EPIPE|ECONNRESET|ENOENT|超时|timeout/i.test(String(msg))

let p = null
let pc = null
let restarts = 0
let backoff = 1000

for (;;) {
  try {
    if (!p) {
      p = await connect()
      await p.init()
      pc = p
      log(restarts === 0 ? '已连接桥接' : `已重连桥接 #${restarts}`)
      backoff = 1000
    }
    await tick(p)
  } catch (e) {
    const msg = (e && e.message) || String(e)
    logErr(msg)
    if (!p || isConnError(msg)) {
      try { if (p && p.socket) p.socket.destroy() } catch {}
      p = null
      restarts += 1
      log('读屏无响应，重连桥接')
      await new Promise((res) => setTimeout(res, backoff))
      backoff = Math.min(backoff * 2, 5000)
      continue
    }
  }
  // 在答题页上把轮询压到 350ms（切题能更快被发现）；其他时候保持 900ms 省电
  await new Promise((res) => setTimeout(res, state.fault ? 3000 : (state.examSeen ? 350 : 900)))
}
