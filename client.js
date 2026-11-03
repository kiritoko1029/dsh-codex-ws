/**
 * Client half of dsh-codex-ws: a compact WS/SSE toggle in the composer toolbar
 * (`conversation.input.right`, next to the model selector). It renders ONLY while
 * the session's current model sits on the `openai` provider — the transport it
 * flips belongs to those models, so every other provider never sees the button.
 * It reads and writes the plugin's Host state at GET/POST /codex-ws/state; the
 * API key never reaches the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-ws',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useSyncExternalStore } = React

    const STATE_ROUTE = 'codex-ws/state'
    const CACHE_KEY = 'dsh-codex-ws:v3'
    const TARGET_PROVIDER = 'openai'

    const subscribeNothing = () => () => {}
    const snapshotNothing = () => null



    const ICONS = {
      ws: h(
        'svg',
        { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true },
        h('path', { d: 'M13 2 3.5 13.5h6L8 22l10.5-12h-6L13.8 2z', fill: 'currentColor' }),
      ),
      sse: h(
        'svg',
        { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true },
        h('path', {
          d: 'M2.5 12h4l2.5-6.5L14 18.5 16.5 12h5',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      ),
    }

    function ensureStyles() {
      if (document.getElementById('dsh-codex-ws-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-codex-ws-style'
      style.textContent = [
        '.dsh-codex-ws-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:9999px;border:1px solid color-mix(in srgb,currentColor 28%,transparent);background:transparent;color:inherit;font-size:11px;font-weight:600;line-height:1;cursor:pointer;user-select:none;transition:opacity .15s,background .15s,border-color .15s;white-space:nowrap}',
        '.dsh-codex-ws-btn:hover{border-color:color-mix(in srgb,currentColor 55%,transparent)}',
        '.dsh-codex-ws-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
        '.dsh-codex-ws-btn[data-pending="true"]{opacity:.55;cursor:wait}',
        '.dsh-codex-ws-btn[data-mode="websocket"]{background:color-mix(in srgb,#10a37f 16%,transparent);border-color:color-mix(in srgb,#10a37f 55%,transparent);color:#10a37f}',
        '.dsh-codex-ws-btn[data-mode="websocket"]:hover{background:color-mix(in srgb,#10a37f 26%,transparent)}',
        '.dsh-codex-ws-btn[data-error="true"]{color:#e5484d;border-color:color-mix(in srgb,#e5484d 60%,transparent)}',
      ].join('\n')
      document.head.appendChild(style)
    }

    function TransportToggle({ providerStore }) {
      const [state, setState] = useState(null)
      const [pending, setPending] = useState(false)
      const [error, setError] = useState(false)
      /** The session's live model provider ('openai' | … | null while unknown). */
      const provider = useSyncExternalStore(
        providerStore ? (onChange) => providerStore.subscribe(onChange) : subscribeNothing,
        providerStore ? () => providerStore.getSnapshot() : snapshotNothing,
        snapshotNothing,
      )

      useEffect(() => {
        ensureStyles()
        let alive = true
        fetch(STATE_ROUTE, { accept: 'application/json' })
          .then((response) => {

            return response.ok ? response.json() : null
          })
          .then((data) => {
            if (!alive || !data) return
            setState(data)
            try {
              localStorage.setItem(CACHE_KEY, JSON.stringify(data))
            } catch {}
          })
          .catch(() => {})
        try {
          const cached = localStorage.getItem(CACHE_KEY)
          if (cached) setState(JSON.parse(cached))
        } catch {}
        return () => {
          alive = false
        }
      }, [])

      const toggle = useCallback(async (field) => {
        if (!state || pending) return
        const patch = field === 'fast'
          ? { fast: state.fast !== true }
          : { transport: state.transport === 'sse' ? 'websocket' : 'sse' }
        setPending(true)
        setError(false)
        try {
          const response = await fetch(STATE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState(data)
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(data))
          } catch {}
        } catch {
          setError(true)
          setTimeout(() => setError(false), 1600)
        } finally {
          setPending(false)
        }
      }, [state, pending])

      if (state === null) {

        return null
      }
      if (state.providerAvailable === false) {

        return null
      }
      // Only OpenAI models ride this transport; other providers never see the button.
      // A blank session has no projection yet; the composer shows the default model then.
      const current = provider?.provider ?? state.defaultProvider ?? null
      if (!providerStore || current !== TARGET_PROVIDER) {
        return null
      }

      const mode = state.transport === 'sse' ? 'sse' : 'ws'
      const host = (() => {
        try {
          return new URL(state.endpoint?.baseURL ?? '').host
        } catch {
          return ''
        }
      })()
      const keyHint = state.endpoint?.hasKey === false ? '（尚未解析到 API Key，WS 不会生效）' : ''
      const title =
        state.transport === 'sse'
          ? `SSE 流式（${state.fast ? 'Fast：插件 Responses 接口，仅文本' : 'openai 渠道直连'}）· 点击让 OpenAI 模型改走 WS 模式${host ? `（${host}）` : ''}${keyHint}`
          : `WS 模式 · OpenAI 模型经 ${host || '中转站'} WebSocket 传输 · 点击切回 SSE 流式${keyHint}`
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(
        'button',
        {
          type: 'button',
          className: 'dsh-codex-ws-btn',
          'data-mode': state.transport === 'sse' ? 'sse' : 'websocket',
          'data-pending': pending ? 'true' : 'false',
          'data-error': error ? 'true' : 'false',
          title,
          disabled: pending,
          'aria-pressed': state.transport !== 'sse',
          onClick: () => toggle('transport'),
        },
        ICONS[mode],
        error ? '!' : mode === 'ws' ? 'WS' : 'SSE',
      ), h('button', {
        type: 'button',
        className: 'dsh-codex-ws-btn',
        'data-mode': state.fast === true ? 'websocket' : 'sse',
        'data-pending': pending ? 'true' : 'false',
        'data-error': error ? 'true' : 'false',
        'aria-pressed': state.fast === true,
        'aria-label': 'Fast 模式',
        disabled: pending,
        title: `Fast 模式${state.fast === true ? '已开启 · 点击关闭' : '已关闭 · 点击开启'}：优先处理（service_tier=priority），可能额外计费，需中转站支持。全局生效，下一次请求使用；SSE 下使用插件 Responses 接口（仅文本）。`,
        onClick: () => toggle('fast'),
      }, ICONS.ws, 'Fast'))
    }

    /** Wrap any {subscribe,getSnapshot} source into a referentially stable provider snapshot. */
    function providerStoreOf(source, read) {
      let last = { provider: null }
      return {
        subscribe: (onChange) => source.subscribe(onChange),
        getSnapshot: () => {
          const provider = read(source.getSnapshot()) ?? null
          if (last.provider !== provider) last = { provider }
          return last
        },
      }
    }

    return {
      // 'sessions' is declared so the facade exposes it; the session's own
      // modelSelection projection (what the model selector renders from) is a
      // plain object graph, so reading it never crosses a context guard.
      inject: ['slots', 'sessions'],
      apply(ctx) {

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'codex-ws-transport',
              order: 40,
              label: 'Codex WS',
              /** The session's model-selection projection powers the button's visibility. */
              inject: (sessionId) => {
                if (typeof sessionId !== 'string') {

                  return {}
                }
                try {
                  const face = ctx.sessions.binding(sessionId).session.projections.faceOf('modelSelection')
                  if (face !== undefined && typeof face.subscribe === 'function') {

                    return { providerStore: providerStoreOf(face, (snap) => snap?.next?.provider) }
                  }

                } catch (error) {

                }
                return {}
              },
            },
            TransportToggle,
          ),
        )
      },
    }
  },
})
