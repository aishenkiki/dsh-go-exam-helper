// 网页界面里的答题助手小条：显示状态 + 两个按钮，数据来自 /plugin-exam/ctl。
// 只依赖 react；样式走内联，不引任何 Host 组件（官方规范要求）。
window.__ModuleLoader__.load({
  id: 'dsh-go-exam-helper',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const API = '/plugin-exam/ctl'
    const API_IMPORT = '/plugin-exam/import'
    const zh = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase().startsWith('zh')
    const t = (a, b) => (zh ? a : b)

    const pill = {
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: '999px',
      padding: '2px 10px',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'pointer',
    }

    function useExam () {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(API + '?action=status', { cache: 'no-store' })
          if (r.ok) setState(await r.json())
        } catch {}
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => { if (alive) await load() }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const upload = React.useCallback(async (file) => {
        if (!file) return
        setBusy(true)
        try {
          const r = await fetch(API_IMPORT + '?name=' + encodeURIComponent(file.name), {
            method: 'POST', body: file, cache: 'no-store',
            headers: { 'content-type': 'application/octet-stream' },
          })
          const j = await r.json().catch(() => null)
          if (j) setNotice(j.ok ? t(`已导入 ${j.imported} 题`, `Imported ${j.imported}`) : t(`导入失败：${j.message || ''}`, `Import failed: ${j.message || ''}`))
        } catch (e) {
          setNotice(t('上传失败：' + (e && e.message), 'Upload failed'))
        }
        setBusy(false)
        await load()
      }, [load])

      const run = React.useCallback(async (action) => {
        setBusy(true)
        try {
          const r = await fetch(API + '?action=' + action, { cache: 'no-store' })
          if (r.ok) setState(await r.json())
        } catch {}
        setBusy(false)
      }, [])

      return { state, busy, notice, setNotice, run, upload }
    }

    function Dock () {
      const { state, busy, notice, setNotice, run, upload } = useExam()
      const fileRef = React.useRef(null)
      const running = !!(state && state.running)
      const label = running
        ? t('答题助手 · 监考中', 'Exam helper · watching')
        : t('答题助手 · 未开始', 'Exam helper · idle')
      const sub = state && state.bank ? t(`题库 ${state.bank} 题`, `${state.bank} questions`) : ''

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', lineHeight: '20px', padding: '2px 2px 4px' },
      },
      h('span', {
        style: {
          width: '8px', height: '8px', borderRadius: '50%', flex: 'none',
          background: running ? '#1a9c58' : 'rgba(127,127,127,.6)',
        },
      }),
      h('span', { style: { opacity: .9 } }, label),
      sub ? h('span', { style: { opacity: .55 } }, sub) : null,
      h('span', { style: { flex: 1 } }),
      h('input', {
        ref: fileRef, type: 'file', accept: '.csv,.tsv,.txt,.json,.xlsx,.xlsm',
        style: { display: 'none' },
        onChange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) upload(f) },
      }),
      h('button', {
        type: 'button', style: { ...pill, opacity: busy ? .45 : 1 }, disabled: busy,
        onClick: () => { setNotice(''); if (fileRef.current) fileRef.current.click() },
      }, t('导入题库', 'Import')),
      notice ? h('span', { style: { opacity: .6, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, notice) : null,
      h('button', {
        type: 'button', style: { ...pill, opacity: running || busy ? .45 : 1 },
        disabled: running || busy,
        onClick: () => run('start'),
      }, t('开始', 'Start')),
      h('button', {
        type: 'button', style: { ...pill, opacity: running && !busy ? 1 : .45 },
        disabled: !running || busy,
        onClick: () => run('stop'),
      }, t('停止', 'Stop')))
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'exam-helper-dock', order: 4,
        }, Dock))
      },
    }
  },
})
