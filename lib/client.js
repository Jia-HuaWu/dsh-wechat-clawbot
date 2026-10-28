/**
 * dsh-wechat-clawbot — Client half（浏览器半边）。
 *
 * 由包根 `package.json` 的 `dsh.client` 声明，宿主会把它作为
 * `/plugins/dsh-wechat-clawbot/client.js` 提供给浏览器。
 *
 * 只做一件事：往设置面板的 `settings.section` 槽位注册「微信 ClawBot」页面。
 * 导航项、面板外壳、Esc 关闭全部复用设置页自带实现，不做任何 DOM 注入。
 *
 * 排序用 `order: 43`——和同机 dsh-ujn-image（`order: 42`）相邻，
 * 于是它稳定地排在「济大词元文生图」下面一格。
 *
 * 数据面统一走宿主半边注册的 `/dsh-wechat-clawbot/*` 路由。
 * 本文件是**手写纯 JS，无构建步骤**，只依赖 `react` / `react/jsx-runtime`
 * 与槽位服务 `slots`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wechat-clawbot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    /**
     * createElement 语义的工厂：`h(type, props, ...children)`。
     *
     * 不能直接用 `jsxRuntime.jsx`：它的签名是 `(type, config, maybeKey)`，
     * 第三个参数会被当成 key 吞掉，子节点整棵丢失。
     */
    const h = (type, props, ...children) => {
      const { key, ...rest } = props ?? {}
      const flat = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
      const config = flat === undefined ? rest : { ...rest, children: flat }
      return key === undefined ? jsxRuntime.jsx(type, config) : jsxRuntime.jsx(type, config, key)
    }

    /** 插件命名空间（字典注册名）。 */
    const NS = 'wechat-clawbot'
    /** 宿主半边注册的接口前缀。 */
    const API = '/dsh-wechat-clawbot'
    /** 目标槽位。 */
    const SLOT = 'settings.section'

    /** 文案（面向中文用户，en 用同一份）。 */
    const zh = {
      nav: '微信 ClawBot',
      title: '微信 ClawBot',
      intro: '把微信接进 DSH：绑定的对话可以直接在微信里聊，也能让 AI 在空闲时主动找你。',

      sectionIdle: '主动待机',
      idleIntro:
        'AI 回复完微信消息后，可以自己决定「过多久再被叫醒」。到点时插件会模拟你发一条提醒（A 类消息），'
        + '让 AI 决定要不要主动说点什么——不说也行。为了不打扰你，你只要发新消息，待机就自动作废。',
      enable: '启用主动待机',
      enableHint: '关掉后，AI 的待机请求一律不生效（存量的定时任务仍会执行）。',
      autoArm: '自动待机（AI 没主动定时也兜底）',
      autoArmHint:
        'AI 是「主动性」工具，实测它经常想不起来调（工具在列表里却从不使用）。'
        + '打开后，它回完消息若没安排待机，插件就按默认时长替你兜底一次。'
        + '关掉则完全交给 AI 自己决定——它不调就永远不会主动找你。',
      silentLimit: '静默熔断（次）',
      silentLimitHint:
        '待机只是提醒，AI 被叫醒后有权不说话。连续这么多次它都保持沉默，就暂停自动兜底'
        + '（它自己定的待机、你发新消息、或保存设置都会解除）。0 = 不限制。',
      diag: '运行诊断',
      diagIdleCalls: (n) => `AI 主动调用待机：${n} 次`,
      diagAutoArmed: (n) => `自动兜底：${n} 次`,
      diagTriggers: (n) => `待机实际触发：${n} 次`,
      diagScheduleCalls: (n) => `AI 登记定时任务：${n} 次`,
      diagLast: (t) => `最近触发：${t}`,
      diagPaused: '静默熔断生效中：AI 连续被叫醒都没说话，自动兜底已暂停（AI 自己定待机、你发新消息、或保存设置都会解除）',
      diagHint:
        '「AI 主动调用」一直是 0 而「自动兜底」在涨，说明模型没在用这个工具、功能靠兜底在跑。'
        + '两者都是 0 且没有待机记录，先确认「启用主动待机」是打开的。',
      defaultMinutes: '默认待机时长（分钟）',
      defaultMinutesHint: 'AI 没指定分钟数时用这个值。1 ~ 1440 分钟。',
      idleMessage: '提醒文案',
      idleMessageHint: '到点发给 AI 的 A 类消息。`{minutes}` 会被替换成实际分钟数。',
      maxChain: '最大连续跳数',
      maxChainHint:
        '连续触发这么多次都没得到你回应就自动停下，避免 AI 自问自答刷屏。0 = 不限制。',

      currentIdle: '当前待机',
      currentIdleNone: '现在没有待机中的心跳。',
      currentIdleActive: (minutes, time) => `已定 ${minutes} 分钟，将在 ${time} 触发。`,
      cancelIdle: '取消当前待机',
      cancelled: '已取消',
      scheduled: '定时任务',
      scheduledNone: '没有登记的定时任务。',
      scheduledDue: (time) => `将在 ${time} 触发`,
      scheduledCount: (n) => `${n} 个待处理`,

      sectionBinding: '当前绑定',
      bindingNone: '还没有任何对话绑定微信。在 DSH 对话里说「把这个对话绑定到微信」即可。',
      bindingRow: (name, user) => `${name} ← ${user}`,
      bindingLive: '在线',
      bindingIdle: '未唤醒',
      openPage: '打开完整状态页',

      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      loadFailed: '读取设置失败',
      retry: '重试',
      loading: '正在读取设置…',
      tools: '可用工具',
      toolsHint: '绑定微信后，AI 会自动使用这些工具。',
      toolIdle: '给自己定待机心跳（多久后再被叫醒）',
      toolSchedule: '登记定时任务（「10 分钟后叫我」）',
      toolSend: '主动推送文本 / 图片',
    }

    /** 主题令牌：跟随 DSH 明暗主题。 */
    const theme = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: '12px',
      },
      primary: { color: 'var(--dsw-alias-label-primary)' },
      secondary: { color: 'var(--dsw-alias-label-secondary)' },
      tertiary: { color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' },
      success: { color: '#1f9d55' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
    }

    /** 通用按钮。 */
    function Button(props) {
      const { children, onClick, disabled, primary, danger, style } = props
      return h('button', {
        type: 'button',
        onClick,
        disabled: Boolean(disabled),
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '12px',
          cursor: disabled ? 'default' : 'pointer',
          padding: '6px 14px',
          borderRadius: '8px',
          border: primary || danger ? 'none' : '1px solid var(--dsw-alias-border-l2)',
          opacity: disabled ? 0.55 : 1,
          background: primary
            ? '#2563eb'
            : danger
              ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
              : 'transparent',
          color: primary
            ? '#fff'
            : danger
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
          ...style,
        },
      }, children)
    }

    /** 带标签 / 提示的文本框。 */
    function Field(props) {
      const { id, label, hint, value, placeholder, type, min, max, onChange } = props
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('label', { htmlFor: id, style: { fontSize: '12px', fontWeight: 600, ...theme.primary } }, label),
        h('input', {
          id,
          type: type ?? 'text',
          value: value ?? '',
          placeholder,
          min,
          max,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => onChange(event.target.value),
          style: {
            appearance: 'none',
            font: 'inherit',
            fontSize: '12px',
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
          },
        }),
        hint ? h('p', { style: { margin: 0, fontSize: '11px', lineHeight: 1.5, ...theme.tertiary } }, hint) : null)
    }

    /** 布尔开关。 */
    function Checkbox(props) {
      const { id, label, hint, checked, onChange } = props
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
        h('label', {
          htmlFor: id,
          style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', ...theme.primary },
        },
        h('input', {
          id,
          type: 'checkbox',
          checked: Boolean(checked),
          onChange: (event) => onChange(event.target.checked),
        }),
        label),
        hint ? h('p', { style: { margin: '0 0 0 22px', fontSize: '11px', lineHeight: 1.5, ...theme.tertiary } }, hint) : null)
    }

    /** 一行状态提示。 */
    function Notice(props) {
      const { text, tone } = props
      if (!text) return null
      return h('div', {
        style: {
          fontSize: '11px',
          lineHeight: 1.5,
          padding: '6px 10px',
          borderRadius: '8px',
          background: tone === 'error'
            ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)'
            : tone === 'ok'
              ? 'color-mix(in srgb, #34c77b 10%, transparent)'
              : 'var(--dsw-alias-bg-layer-4)',
          ...(tone === 'error' ? theme.error : tone === 'ok' ? theme.success : theme.secondary),
        },
      }, text)
    }

    /** 设置页主体。 */
    function WechatSection(props) {
      const { t } = props
      const [phase, setPhase] = react.useState('loading')
      const [error, setError] = react.useState('')
      const [draft, setDraft] = react.useState(null)
      const [idle, setIdle] = react.useState(null)
      const [schedules, setSchedules] = react.useState([])
      const [bindingCount, setBindingCount] = react.useState(0)
      const [diagnostics, setDiagnostics] = react.useState(null)
      const [busy, setBusy] = react.useState(null)
      const [notice, setNotice] = react.useState(null)

      /** 拉取设置。 */
      const load = react.useCallback(async () => {
        setPhase('loading')
        setError('')
        try {
          const response = await fetch(`${API}/idle`)
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setDraft({ ...body.settings })
          setIdle(body.idle ?? null)
          setSchedules(Array.isArray(body.schedules) ? body.schedules : [])
          setBindingCount(Number(body.bindingCount ?? 0))
          setDiagnostics(body.diagnostics ?? null)
          setPhase('ready')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setPhase('failed')
        }
      }, [])

      react.useEffect(() => { load() }, [load])

      /** 局部更新字段。 */
      const edit = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

      /** 保存设置。 */
      const save = async () => {
        setBusy('save')
        setNotice(null)
        try {
          const response = await fetch(`${API}/idle/save`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setDraft({ ...body.settings })
          setIdle(body.idle ?? null)
          setNotice({ text: t('saved'), tone: 'ok' })
        } catch (cause) {
          setNotice({ text: String(cause?.message ?? cause), tone: 'error' })
        } finally {
          setBusy(null)
        }
      }

      /** 取消当前待机心跳。 */
      const cancelIdle = async () => {
        setBusy('cancel')
        setNotice(null)
        try {
          const response = await fetch(`${API}/idle/cancel`, { method: 'POST' })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setIdle(null)
          setNotice({ text: t('cancelled'), tone: 'ok' })
        } catch (cause) {
          setNotice({ text: String(cause?.message ?? cause), tone: 'error' })
        } finally {
          setBusy(null)
        }
      }

      /** 时间格式化。 */
      const timeText = (ms) => {
        if (!ms) return '—'
        try {
          return new Date(Number(ms)).toLocaleString('zh-CN')
        } catch {
          return '—'
        }
      }

      if (phase === 'loading') {
        return h('div', { style: { padding: '24px', fontSize: '13px', ...theme.tertiary } }, t('loading'))
      }
      if (phase === 'failed') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '24px' } },
          h('p', { style: { margin: 0, fontSize: '13px', ...theme.error } }, `${t('loadFailed')}：${error}`),
          h(Button, { onClick: load }, t('retry')))
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' } },

        // 标题
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, t('title')),
          h('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.6, ...theme.tertiary } }, t('intro'))),

        // 当前绑定
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px 16px', ...theme.card } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, ...theme.primary } }, t('sectionBinding')),
          bindingCount === 0
            ? h('p', { style: { margin: 0, fontSize: '12px', ...theme.tertiary } }, t('bindingNone'))
            : h('p', { style: { margin: 0, fontSize: '12px', ...theme.secondary } },
                `已绑定 ${bindingCount} 个对话`),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(Button, {
              onClick: () => window.open(`${API}/page`, '_blank', 'noopener'),
            }, t('openPage')))),

        // 主动待机
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px', ...theme.card } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, ...theme.primary } }, t('sectionIdle')),
          h('p', { style: { margin: 0, fontSize: '11px', lineHeight: 1.6, ...theme.tertiary } }, t('idleIntro')),

          h(Checkbox, {
            id: 'wechat-idle-enabled',
            label: t('enable'),
            hint: t('enableHint'),
            checked: draft.enabled === true,
            onChange: (v) => edit('enabled', v),
          }),
          h(Field, {
            id: 'wechat-idle-minutes',
            label: t('defaultMinutes'),
            hint: t('defaultMinutesHint'),
            type: 'number',
            min: 1,
            max: 1440,
            value: String(draft.defaultMinutes ?? ''),
            onChange: (v) => edit('defaultMinutes', Number(v)),
          }),
          h(Field, {
            id: 'wechat-idle-message',
            label: t('idleMessage'),
            hint: t('idleMessageHint'),
            value: draft.idleMessage ?? '',
            onChange: (v) => edit('idleMessage', v),
          }),
          h(Field, {
            id: 'wechat-idle-maxchain',
            label: t('maxChain'),
            hint: t('maxChainHint'),
            type: 'number',
            min: 0,
            value: String(draft.maxChain ?? ''),
            onChange: (v) => edit('maxChain', Number(v)),
          }),
          h(Checkbox, {
            id: 'wechat-idle-autoarm',
            label: t('autoArm'),
            hint: t('autoArmHint'),
            checked: draft.autoArm !== false,
            onChange: (v) => edit('autoArm', v),
          }),
          h(Field, {
            id: 'wechat-idle-silentlimit',
            label: t('silentLimit'),
            hint: t('silentLimitHint'),
            type: 'number',
            min: 0,
            value: String(draft.silentLimit ?? ''),
            onChange: (v) => edit('silentLimit', Number(v)),
          }),

          // 当前待机状态
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px' } },
            h('h4', { style: { margin: 0, fontSize: '12px', fontWeight: 600, ...theme.primary } }, t('currentIdle')),
            idle
              ? h('p', { style: { margin: 0, fontSize: '12px', ...theme.secondary } },
                  t('currentIdleActive')(idle.minutes, timeText(idle.dueAt)))
              : h('p', { style: { margin: 0, fontSize: '12px', ...theme.tertiary } }, t('currentIdleNone')),
            idle ? h(Button, { onClick: cancelIdle, disabled: busy !== null, danger: true }, t('cancelIdle')) : null),

          // 运行诊断：AI 到底有没有在调工具
          diagnostics
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '8px', borderTop: '0.5px solid var(--dsw-alias-border-l4)', marginTop: '4px' } },
                h('h4', { style: { margin: 0, fontSize: '12px', fontWeight: 600, ...theme.primary } }, t('diag')),
                diagnostics.autoArmPaused
                  ? h(Notice, { text: t('diagPaused'), tone: 'error' })
                  : null,
                h('p', { style: { margin: 0, fontSize: '11px', ...theme.secondary } },
                  t('diagIdleCalls')(diagnostics.idleToolCalls ?? 0)
                  + '　·　' + t('diagAutoArmed')(diagnostics.autoArmed ?? 0)),
                h('p', { style: { margin: 0, fontSize: '11px', ...theme.secondary } },
                  t('diagTriggers')(diagnostics.idleTriggers ?? 0)
                  + '　·　' + t('diagScheduleCalls')(diagnostics.scheduleToolCalls ?? 0)),
                diagnostics.lastTriggeredAt
                  ? h('p', { style: { margin: 0, fontSize: '11px', ...theme.tertiary } },
                      t('diagLast')(timeText(diagnostics.lastTriggeredAt)))
                  : null,
                h('p', { style: { margin: 0, fontSize: '10px', lineHeight: 1.5, ...theme.tertiary } }, t('diagHint')))
            : null,

          // 定时任务
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '8px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
              h('h4', { style: { margin: 0, fontSize: '12px', fontWeight: 600, ...theme.primary } }, t('scheduled')),
              schedules.length > 0
                ? h('span', { style: { fontSize: '11px', ...theme.tertiary } }, t('scheduledCount')(schedules.length))
                : null),
            schedules.length === 0
              ? h('p', { style: { margin: 0, fontSize: '12px', ...theme.tertiary } }, t('scheduledNone'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  ...schedules.map((s) => h('p', {
                    key: s.id,
                    style: { margin: 0, fontSize: '12px', ...theme.secondary },
                  }, `${s.message || '（默认文案）'} · ${t('scheduledDue')(timeText(s.dueAt))}`)))),

          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h(Button, { primary: true, onClick: save, disabled: busy !== null }, busy === 'save' ? t('saving') : t('save'))),
          h(Notice, { text: notice?.text, tone: notice?.tone })),

        // 可用工具
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px 16px', ...theme.card } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, ...theme.primary } }, t('tools')),
          h('p', { style: { margin: 0, fontSize: '11px', ...theme.tertiary } }, t('toolsHint')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            ...[
              ['wechat_idle', t('toolIdle')],
              ['wechat_schedule', t('toolSchedule')],
              ['wechat_send_message', t('toolSend')],
            ].map(([name, desc]) => h('div', {
              key: name,
              style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' },
            },
            h('code', {
              style: {
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-4)',
                ...theme.secondary,
              },
            }, name),
            h('span', { style: { fontSize: '11px', ...theme.tertiary } }, desc))))))
    }

    /**
     * 需要 `slots`（注册页面）与 `locale`（提供 t()）。
     * 目标槽位由 ui-settings 声明，因此用 `slots.inject()` 等它就位。
     */
    const inject = ['slots', 'locale']

    /** @param ctx - 客户端根上下文 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en: zh }), 'wechat-clawbot:dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'wechat-clawbot',
        // 43 —— 紧跟「济大词元文生图」（42）之后。
        order: 43,
        label: () => t('nav'),
        locale: NS,
      }, WechatSection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.WechatSection = WechatSection
    return module.exports
  },
})
