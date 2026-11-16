/* global window, document, navigator */

window.__ModuleLoader__.load({
  id: 'dsh-diy',
  factory: require => {
    const module = {exports: {}}
    const React = require('react')
    const h = React.createElement
    const {useEffect, useState} = React
    const ROOT = '/api-dsh-diy'
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      accent: 'var(--dsw-alias-link, #2f6bff)',
      danger: '#c94040',
      surface: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.06))',
    }

    async function api(path, method = 'GET', body) {
      const response = await fetch(ROOT + path, {
        method,
        credentials: 'same-origin',
        headers: method === 'POST' ? {'content-type': 'application/json'} : undefined,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }

    function Button({children, onClick, primary, disabled}) {
      return h('button', {
        type: 'button', onClick, disabled,
        style: {
          appearance: 'none', font: 'inherit', fontSize: 13, padding: '7px 12px',
          borderRadius: 7, border: `1px solid ${primary ? C.accent : C.border}`,
          background: primary ? C.accent : 'transparent', color: primary ? '#fff' : C.text,
          opacity: disabled ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer',
        },
      }, children)
    }

    function Card({children}) {
      return h('div', {style: {border: `1px solid ${C.border}`, background: C.surface, borderRadius: 10, padding: 12, marginTop: 10}}, children)
    }

    function DiyPanel() {
      const [meta, setMeta] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [workspaceId, setWorkspaceId] = useState('general')
      const [workspace, setWorkspace] = useState(null)
      const [selections, setSelections] = useState({})
      const [goal, setGoal] = useState('')
      const [recommendation, setRecommendation] = useState(null)
      const [plan, setPlan] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      useEffect(() => {
        let active = true
        Promise.all([api('/meta'), api('/workspaces')]).then(([info, rows]) => {
          if (!active) return
          setMeta(info)
          setWorkspaces(rows)
          if (rows.length && !rows.some(row => row.id === workspaceId)) setWorkspaceId(rows[0].id)
        }).catch(reason => active && setError(reason.message))
        return () => { active = false }
      }, [])

      useEffect(() => {
        let active = true
        if (!workspaceId) return () => { active = false }
        api('/workspace?id=' + encodeURIComponent(workspaceId)).then(value => {
          if (!active) return
          setWorkspace(value)
          setSelections({})
          setPlan(null)
        }).catch(reason => active && setError(reason.message))
        return () => { active = false }
      }, [workspaceId])

      const recommend = async () => {
        setBusy(true); setError(''); setPlan(null)
        try { setRecommendation(await api('/recommend', 'POST', {goal})) }
        catch (reason) { setError(reason.message) }
        finally { setBusy(false) }
      }

      const preview = async () => {
        setBusy(true); setError('')
        try { setPlan(await api('/plan', 'POST', {workspace: workspaceId, selections})) }
        catch (reason) { setError(reason.message); setPlan(null) }
        finally { setBusy(false) }
      }

      const fieldStyle = {
        width: '100%', boxSizing: 'border-box', color: C.text, background: 'transparent',
        border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px', font: 'inherit', fontSize: 13,
      }
      const small = {fontSize: 12, color: C.sub, lineHeight: 1.55}

      return h('div', {style: {height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: 14, color: C.text, font: '13px/1.55 system-ui, sans-serif'}},
        h('div', {style: {fontSize: 18, fontWeight: 700}}, 'DSH DIY'),
        h('div', {style: {...small, marginTop: 3}}, meta ? `当前 profile：${meta.profile || '未知'} · 目录 ${meta.pluginCount} 个候选插件 · ${meta.catalogAsOf}` : '正在读取 DSH 状态…'),
        h(Card, null,
          h('div', {style: {fontWeight: 650}}, '你想完成什么？'),
          h('div', {style: {...small, margin: '3px 0 9px'}}, '先描述任务，查看能力匹配和候选插件。当前推荐来自目录声明，尚不代表插件组合已端到端验证。'),
          h('textarea', {value: goal, onChange: event => setGoal(event.target.value), rows: 3, placeholder: '例如：用已有素材剪一条短视频，并处理字幕和音轨', style: {...fieldStyle, resize: 'vertical'}}),
          h('div', {style: {marginTop: 8}}, h(Button, {primary: true, disabled: busy || goal.trim().length < 2, onClick: recommend}, busy ? '处理中…' : '匹配能力')),
        ),
        recommendation ? h(Card, null,
          h('div', {style: {fontWeight: 650}}, '能力与插件候选'),
          recommendation.capabilities.length
            ? h('div', {style: {...small, marginTop: 5}}, recommendation.capabilities.map(item => item.name.zh || item.name.en).join('、'))
            : h('div', {style: {...small, marginTop: 5}}, '没有匹配到目录中的能力。'),
          ...recommendation.candidates.map(candidate => h('div', {key: candidate.package, style: {borderTop: `1px solid ${C.border}`, marginTop: 9, paddingTop: 8}},
            h('div', {style: {fontWeight: 600}}, `${candidate.package} · ${candidate.evidence.level}`),
            h('div', {style: small}, candidate.summary.zh || candidate.summary.en),
            h('div', {style: {...small, marginTop: 3}}, `覆盖：${candidate.capabilityNames.join('、') || '—'}；兼容性：${candidate.compatibility}`),
            h('div', {style: {...small, marginTop: 3}}, candidate.reasons.join(' · ')),
          )),
          recommendation.missingCapabilities?.length ? h('div', {style: {...small, color: C.danger, marginTop: 8}}, `暂缺候选能力：${recommendation.missingCapabilities.join('、')}`) : null,
        ) : null,
        h(Card, null,
          h('div', {style: {fontWeight: 650}}, '从工作台原型开始'),
          h('div', {style: {...small, margin: '3px 0 9px'}}, '先选预设，再按步骤选择插件。使用几次后，你可以回顾每个模块，按实际缺口调整。'),
          h('select', {value: workspaceId, onChange: event => setWorkspaceId(event.target.value), style: fieldStyle},
            ...workspaces.map(row => h('option', {key: row.id, value: row.id}, row.name.zh || row.name.en))),
          workspace ? h('div', {style: {...small, marginTop: 7}}, workspace.description.zh || workspace.description.en) : null,
          workspace?.steps.map(step => {
            const options = step.pluginChoices.map(packageName => ({packageName, label: packageName}))
            return h('div', {key: step.id, style: {marginTop: 10}},
              h('div', {style: {fontWeight: 600}}, `${step.id}${step.optional ? ' · 可选' : ' · 必需'}`),
              h('div', {style: small}, step.capability),
              h('select', {
                value: selections[step.id] || '',
                onChange: event => setSelections(current => ({...current, [step.id]: event.target.value || undefined})),
                style: {...fieldStyle, marginTop: 5},
              },
                h('option', {value: ''}, step.optional ? '不添加此步骤' : '选择一个插件'),
                ...options.map(option => h('option', {key: option.packageName, value: option.packageName}, option.label)),
              ),
            )
          }) || null,
          h('div', {style: {marginTop: 10}}, h(Button, {primary: true, disabled: busy || !workspace, onClick: preview}, busy ? '生成中…' : '预览安装方案')),
        ),
        plan ? h(Card, null,
          h('div', {style: {fontWeight: 650}}, '安装方案预览'),
          h('div', {style: small}, `目标 profile：${plan.plan.target.profile} · 状态：仅预览，尚未安装`),
          plan.plan.operations.length
            ? plan.plan.operations.map(operation => h('div', {key: operation.package, style: {marginTop: 8}},
                h('div', {style: {fontWeight: 600}}, operation.spec),
                h('code', {style: {...small, overflowWrap: 'anywhere'}}, operation.argv.join(' ')),
              ))
            : h('div', {style: {...small, marginTop: 8}}, '当前选择没有需要新增的插件。'),
          ...plan.plan.warnings.map((warning, index) => h('div', {key: index, style: {...small, color: '#a66b00', marginTop: 6}}, warning.message)),
        ) : null,
        error ? h('div', {style: {color: C.danger, marginTop: 9}}, error) : null,
      )
    }

    let sidebarApi = null
    function SettingsSection() {
      const [message, setMessage] = useState('')
      return h('div', {style: {color: C.text, padding: '4px 0'}},
        h('div', {style: {fontWeight: 650}}, 'DSH DIY 工作台引导'),
        h('div', {style: {fontSize: 12, color: C.sub, margin: '5px 0 9px'}}, '按目标查找插件、选择场景预设并预览安装方案。'),
        sidebarApi ? h(Button, {primary: true, onClick: () => {
          try { sidebarApi.openTab('dsh-diy'); setMessage('已打开右侧工作台') }
          catch { setMessage('请先打开一个对话，再从右侧栏打开工作台') }
        }}, '打开工作台') : null,
        message ? h('div', {style: {fontSize: 12, color: C.sub, marginTop: 6}}, message) : null,
      )
    }

    const SIDEBAR_TAB_ID = 'dsh-diy/workspace'
    function DiyIcon({size = 16}) {
      return h('svg', {width: size, height: size, viewBox: '0 0 24 24', fill: 'none'},
        h('path', {d: 'M4 6h16M4 12h10M4 18h7M18 10v8m-3-3 3 3 3-3', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round'}))
    }

    function apply(ctx) {
      try {
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], scope => {
          const right = (scope.get && scope.get('sidebarRight')) || scope.sidebarRight
          const tabs = (scope.get && scope.get('sidebarRightTabs')) || scope.sidebarRightTabs
          if (!tabs?.register) return
          const effect = (fn, label) => scope.effect ? scope.effect(fn, label) : fn()
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: 'dsh-diy',
            priority: 'extension',
            keepMounted: true,
            title: () => 'DSH DIY',
            guide: [{
              id: 'dsh-diy', order: 65,
              title: () => 'DIY 工作台',
              description: () => '按目标选择并组装 DSH 插件',
              icon: DiyIcon,
            }],
          }), 'dsh-diy: sidebar type')
          const slots = scope.slots || ctx.slots
          const body = () => slots.register({name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID}, DiyPanel)
          effect(() => slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body(), 'dsh-diy: sidebar body')
          if (right?.openTab) {
            sidebarApi = right
            effect(() => () => { if (sidebarApi === right) sidebarApi = null }, 'dsh-diy: sidebar api')
          }
        })
      } catch (error) { console.warn('[dsh-diy] sidebar registration failed', error) }

      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          {name: 'settings.section', id: 'dsh-diy', order: 35, label: () => 'DSH DIY'},
          SettingsSection,
        ))
      } catch (error) { console.warn('[dsh-diy] settings registration failed', error) }
    }

    module.exports = {name: 'dsh-diy', inject: ['slots'], apply}
    return module.exports
  },
})
