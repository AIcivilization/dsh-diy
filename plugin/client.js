/* global window, document, navigator */

window.__ModuleLoader__.load({
  id: 'dsh-diy',
  factory: require => {
    const module = {exports: {}}
    const React = require('react')
    const h = React.createElement
    const {useEffect, useRef, useState} = React
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
      if (!response.ok) {
        const error = new Error(value.error || `HTTP ${response.status}`)
        Object.assign(error, value)
        throw error
      }
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

    function Card({children, id}) {
      return h('div', {id, style: {border: `1px solid ${C.border}`, background: C.surface, borderRadius: 10, padding: 12, marginTop: 10}}, children)
    }

    let composerFor = null
    let startSelectionSession = null
    async function sendToChat(sessionId, text) {
      const input = sessionId && composerFor ? composerFor(sessionId) : null
      if (!input) return 'none'
      const snapshot = () => { try { return input.snapshot || input.state?.get?.() || {} } catch { return {} } }
      const draft = () => String(snapshot().draft || '').trim()
      if (draft()) return 'draft'
      if ((snapshot().queue || []).some(item => (item.content || []).filter(block => block.type === 'text').map(block => block.text).join('').trim() === text.trim())) return 'queued'
      input.setDraft(text)
      for (let i = 0; i < 20 && !draft(); i++) await new Promise(resolve => setTimeout(resolve, 25))
      if (!draft()) return 'none'
      await input.submit('queue')
      return 'sent'
    }

    function DiyPanel({sessionId}) {
      const [meta, setMeta] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [workspaceId, setWorkspaceId] = useState('general')
      const [workspace, setWorkspace] = useState(null)
      const [selections, setSelections] = useState({})
      const [workspaceDraft, setWorkspaceDraft] = useState(null)
      const [loadedDraft, setLoadedDraft] = useState(null)
      const pendingDraft = useRef(null)
      const [goal, setGoal] = useState('')
      const [recommendation, setRecommendation] = useState(null)
      const [plan, setPlan] = useState(null)
      const [backups, setBackups] = useState([])
      const [busy, setBusy] = useState(false)
      const [backupBusy, setBackupBusy] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [recoveryCommand, setRecoveryCommand] = useState('')
      const [aiMessage, setAiMessage] = useState('')
      const [startingAi, setStartingAi] = useState(false)

      useEffect(() => {
        let active = true
        Promise.all([api('/meta'), api('/workspaces'), api('/backups')]).then(([info, rows, saved]) => {
          if (!active) return
          setMeta(info); setWorkspaces(rows); setBackups(saved)
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
          const pending = pendingDraft.current
          if (pending && pending.workspace.id === value.id) {
            setSelections(pending.selections)
            pendingDraft.current = null
          } else setSelections({})
          setPlan(null)
        }).catch(reason => active && setError(reason.message))
        return () => { active = false }
      }, [workspaceId])

      useEffect(() => {
        if (!sessionId) { setWorkspaceDraft(null); return undefined }
        let active = true
        const refreshDraft = async () => {
          try {
            const value = await api('/draft?sessionId=' + encodeURIComponent(String(sessionId)))
            if (active) setWorkspaceDraft(current => current?.id === value?.id ? current : value)
          } catch { /* A transient poll failure should not interrupt panel use. */ }
        }
        refreshDraft()
        const timer = window.setInterval(refreshDraft, 1500)
        return () => { active = false; window.clearInterval(timer) }
      }, [sessionId])

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
      const refreshBackups = async () => setBackups(await api('/backups'))
      const createBackup = async () => {
        setBackupBusy(true); setError(''); setMessage(''); setRecoveryCommand('')
        try {
          const saved = await api('/backup', 'POST', {})
          await refreshBackups()
          setRecoveryCommand(saved.restoreCommand)
          setMessage(`时间胶囊已创建：${new Date(saved.createdAt).toLocaleString()}（${saved.files.join('、')}）。恢复不依赖 dsh-diy 插件。`)
        } catch (reason) { setError(reason.message) }
        finally { setBackupBusy(false) }
      }
      const restoreBackup = async backupId => {
        if (!window.confirm('将先保存当前状态，再恢复此快照中的 profile 配置文件。继续吗？')) return
        setBackupBusy(true); setError(''); setMessage('')
        try {
          const result = await api('/restore', 'POST', {backupId})
          await refreshBackups()
          setMessage(`配置已恢复。请完全退出并重启 DSH，再运行：${result.command}`)
        } catch (reason) { setError(reason.message) }
        finally { setBackupBusy(false) }
      }
      const copyRecoveryCommand = async command => {
        setRecoveryCommand(command)
        try {
          await navigator.clipboard.writeText(command)
          setMessage('独立恢复命令已复制。请保存到安全位置；即使卸载 dsh-diy，仍可在终端运行。')
        } catch {
          setMessage('请复制下方命令并保存到安全位置；此命令不依赖 dsh-diy 插件。')
        }
      }
      const applyPlan = async () => {
        if (!window.confirm('将先自动创建恢复点，再安装所选插件到当前 DSH profile。安装修改 profile，完成后需要重启 DSH。继续吗？')) return
        setBusy(true); setError(''); setMessage('')
        try {
          const result = await api('/apply', 'POST', {workspace: workspaceId, selections})
          setMessage(result.message || `安装完成：${(result.installed || []).join('、')}。请重启 DSH。`)
          await refreshBackups()
        } catch (reason) {
          const rollbackStatus = reason.rollback?.map(row => `${row.package}${row.ok ? ' 已回退' : ` 回退失败：${row.error}`}`).join('；')
          const fileStatus = reason.profileFilesRestored === true ? '已恢复 profile 配置文件' : reason.profileFilesRestored === false ? `profile 配置文件恢复失败：${reason.restoreError || '未知错误'}` : ''
          setError([reason.message, rollbackStatus, fileStatus, reason.recoveryPoint?.id ? `恢复点：${reason.recoveryPoint.id}` : ''].filter(Boolean).join('。'))
          try { await refreshBackups() } catch {}
        }
        finally { setBusy(false) }
      }
      const askAi = async () => {
        setAiMessage(''); setError(''); setStartingAi(true)
        const prompt = `我正在使用 DSH DIY 设计工作台。我的目标是：${goal.trim() || '请先结合我选择的工作台预设，与我澄清需求'}。请作为插件选型顾问，调用 diy_recommend 查询目录，必要时调用 diy_workspaces 查看预设。先问清关键需求，再用通俗中文比较候选插件：具体做什么、适合谁、前置条件/限制、相互差异、兼容性与验证状态。明确哪些只是目录声明，不要虚构能力或宣称未验证的插件衔接已经可用。先和我一起推导和确认组合；只有我明确认可方案后，才调用 diy_submit_workspace_draft，把工作台 id、每个已选步骤的精确 package、逐步理由和总结提交给右侧 DSH DIY 面板。该工具只创建待确认草案，不会安装。完成后提醒我回到右侧 DIY，点击“载入 AI 草案”，在那里检查、调整、预览和自行确认安装。`
        try {
          if (!startSelectionSession) throw new Error('此 DSH 版本没有提供新建会话接口。')
          const dedicatedSessionId = await startSelectionSession()
          const status = await sendToChat(dedicatedSessionId, prompt)
          setAiMessage(status === 'sent' ? '已切换到独立的 AI 选型对话，任务已发送。你可以在新对话中逐步澄清和确认；完成后草案会回到右侧 DIY。原有对话没有被修改。' : status === 'draft' ? '新会话输入框已有未发送内容；请检查新会话后再试。原有对话未改动。' : status === 'queued' ? '选型任务已在专用新会话队列中。' : '新会话已打开，但无法连接它的输入框；请在新对话中手动描述需求。')
        } catch (reason) { setAiMessage(`未能启动独立选型对话：${reason.message}`) }
        finally { setStartingAi(false) }
      }
      const loadWorkspaceDraft = async () => {
        if (!workspaceDraft) return
        pendingDraft.current = workspaceDraft
        setLoadedDraft(workspaceDraft)
        setPlan(null)
        if (workspaceId === workspaceDraft.workspace.id) {
          setSelections(workspaceDraft.selections)
          pendingDraft.current = null
        }
        else setWorkspaceId(workspaceDraft.workspace.id)
        try {
          await api('/draft/ack', 'POST', {sessionId: String(sessionId), draftId: workspaceDraft.id})
          setWorkspaceDraft(null)
          setMessage('AI 草案已载入右侧工作台。请检查每一步选择和理由，再预览方案；尚未安装任何插件。')
        } catch (reason) { setError(`载入草案时未能确认：${reason.message}`) }
        window.setTimeout(() => document.getElementById('dsh-diy-workspace-editor')?.scrollIntoView({behavior: 'smooth', block: 'start'}), 100)
      }

      const fieldStyle = {width: '100%', boxSizing: 'border-box', color: C.text, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px', font: 'inherit', fontSize: 13}
      const small = {fontSize: 12, color: C.sub, lineHeight: 1.55}
      const evidenceText = p => p.evidence?.workflowVerified ? '端到端流程已验证' : p.evidence?.level === 'install-verified' ? '单插件安装已验证，完整流程未验证' : '目录/插件说明中的能力声明，DIY 尚未单独验证'
      const pluginCard = (plugin, selected, onSelect) => h('div', {key: plugin.package, style: {border: `1px solid ${C.border}`, borderRadius: 8, padding: 8, marginTop: 7}},
        h('div', {style: {fontWeight: 600}}, plugin.displayName || plugin.package),
        h('div', {style: small}, plugin.whatItDoes?.zh || plugin.summary?.zh || ''),
        h('div', {style: {...small, marginTop: 3}}, `适合：${plugin.bestFor || '目录未提供明确适用场景'}`),
        h('div', {style: {...small, marginTop: 3}}, `需要了解：${plugin.tradeoffs || '插件前置条件需查看详情'}`),
        h('div', {style: {...small, marginTop: 3}}, `验证：${evidenceText(plugin)}；当前 DSH/平台兼容性需核实。`),
        plugin.links?.npm ? h('a', {href: plugin.links.npm, target: '_blank', rel: 'noreferrer', style: {fontSize: 12, color: C.accent}}, '查看插件详情') : null,
        onSelect ? h('div', {style: {marginTop: 6}}, h(Button, {primary: selected, onClick: onSelect}, selected ? '已选择' : `选择此插件`)) : null,
      )

      return h('div', {style: {height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: 14, color: C.text, font: '13px/1.55 system-ui, sans-serif'}},
        h('div', {style: {fontSize: 18, fontWeight: 700}}, 'DSH DIY'),
        h('div', {style: {...small, marginTop: 3}}, meta ? `当前 profile：${meta.profile || '未知'} · ${meta.pluginCount} 个目录候选 · 数据截至 ${meta.catalogAsOf}` : '正在读取 DSH 状态…'),
        h(Card, null,
          h('div', {style: {fontWeight: 650}}, '第 1 步 · 创建 DSH 时间胶囊'),
          h('div', {style: {...small, margin: '3px 0 9px'}}, '保存当前 profile 文件，并生成一个独立 Node 恢复脚本。命令可复制到安全位置；即使之后卸载 dsh-diy，脚本仍可恢复配置并按锁文件重建插件依赖。'),
          h(Button, {primary: true, disabled: backupBusy || !meta?.profile, onClick: createBackup}, backupBusy ? '处理中…' : '创建时间胶囊'),
          backups.length ? h('div', {style: {marginTop: 8}}, backups.map((item, index) => h('div', {key: item.id, style: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 6}},
            h('span', {style: small}, `${index === 0 ? '最近 · ' : ''}${new Date(item.createdAt).toLocaleString()} · ${item.files.length} 项`),
            h('div', {style: {display: 'flex', gap: 5}}, h(Button, {disabled: backupBusy || !item.restoreCommand, onClick: () => copyRecoveryCommand(item.restoreCommand)}, item.restoreCommand ? '复制终端恢复命令' : '仅支持面板恢复'), h(Button, {disabled: backupBusy, onClick: () => restoreBackup(item.id)}, '面板恢复')),
          ))) : h('div', {style: {...small, marginTop: 7}}, '尚无恢复点。')),
          recoveryCommand ? h('div', {style: {marginTop: 8}},
            h('div', {style: {...small, marginBottom: 4}}, '独立恢复命令（保存后可在终端运行；运行前请完全退出 DSH）：'),
            h('code', {style: {display: 'block', padding: 8, borderRadius: 6, background: C.surface, overflowWrap: 'anywhere', userSelect: 'all', fontSize: 11}}, recoveryCommand),
            h('div', {style: {marginTop: 5}}, h(Button, {onClick: () => copyRecoveryCommand(recoveryCommand)}, '复制恢复命令')),
          ) : null,
        workspaceDraft ? h(Card, null,
          h('div', {style: {fontWeight: 650}}, 'AI 已完成推导 · 工作台草案待载入'),
          h('div', {style: {...small, marginTop: 3}}, `${workspaceDraft.workspace.name} · ${new Date(workspaceDraft.createdAt).toLocaleTimeString()}`),
          workspaceDraft.summary ? h('div', {style: {...small, marginTop: 6}}, workspaceDraft.summary) : null,
          ...workspaceDraft.selected.map(item => h('div', {key: item.stepId, style: {borderTop: `1px solid ${C.border}`, marginTop: 6, paddingTop: 5}},
            h('div', {style: {fontWeight: 600}}, `${item.stepName}：${item.displayName}`),
            item.reason ? h('div', {style: small}, item.reason) : null,
          )),
          h('div', {style: {marginTop: 8}}, h(Button, {primary: true, onClick: loadWorkspaceDraft}, '载入 AI 草案到右侧设置')),
          h('div', {style: {...small, marginTop: 5}}, '载入只会预填选择，不会安装。你可以逐项修改，然后预览并自行确认。'),
        ) : null,
        h(Card, null,
          h('div', {style: {fontWeight: 650}}, '你想完成什么？'),
          h('div', {style: {...small, margin: '3px 0 9px'}}, '目录检索只负责找线索；“请 AI 帮我选”会先打开一个空白的新对话，再让助手追问需求、比较插件并解释选择理由。不会把任务发进当前项目对话。'),
          h('textarea', {value: goal, onChange: event => setGoal(event.target.value), rows: 3, placeholder: '例如：用已有素材剪一条短视频，自动整理字幕和音轨', style: {...fieldStyle, resize: 'vertical'}}),
          h('div', {style: {display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap'}}, h(Button, {disabled: busy || goal.trim().length < 2, onClick: recommend}, busy ? '检索中…' : '查找目录候选'), h(Button, {primary: true, disabled: startingAi, onClick: askAi}, startingAi ? '正在新建选型对话…' : '请 AI 帮我选（新对话）')),
          aiMessage ? h('div', {style: {...small, marginTop: 7}}, aiMessage) : null,
        ),
        recommendation ? h(Card, null,
          h('div', {style: {fontWeight: 650}}, '候选插件：功能、适用场景和取舍'),
          recommendation.capabilities.length ? h('div', {style: {...small, marginTop: 5}}, `匹配到的需求：${recommendation.capabilities.map(item => item.name.zh || item.name.en).join('、')}`) : h('div', {style: small}, '目录中没有匹配的能力。'),
          ...recommendation.candidates.map(candidate => h('div', {key: candidate.package, style: {borderTop: `1px solid ${C.border}`, marginTop: 9, paddingTop: 8}},
            pluginCard({package: candidate.package, displayName: candidate.displayName, whatItDoes: candidate.whatItDoes, summary: candidate.summary, bestFor: candidate.bestFor, tradeoffs: candidate.tradeoffs, evidence: candidate.evidence, links: candidate.links}),
            h('div', {style: {...small, marginTop: 4}}, `覆盖：${candidate.capabilityNames.join('、') || '—'}；${candidate.compatibilityLabel || '兼容性未核实'}。${candidate.recommendation || ''}`),
          )),
          recommendation.missingCapabilities?.length ? h('div', {style: {...small, color: C.danger, marginTop: 8}}, `目录暂缺候选：${recommendation.missingCapabilities.join('、')}`) : null,
        ) : null,
        h(Card, {id: 'dsh-diy-workspace-editor'},
          h('div', {style: {fontWeight: 650}}, '选择一个工作台原型'),
          h('div', {style: {...small, margin: '3px 0 9px'}}, '预设是可修改的初始组合。逐步选择后先预览，再确认安装；使用一段时间后可以按评分和实际缺口调整。'),
          h('select', {value: workspaceId, onChange: event => setWorkspaceId(event.target.value), style: fieldStyle}, ...workspaces.map(row => h('option', {key: row.id, value: row.id}, row.name.zh || row.name.en))),
          workspace ? h('div', {style: {...small, marginTop: 7}}, workspace.description.zh || workspace.description.en) : null,
          loadedDraft?.workspace.id === workspaceId ? h('div', {style: {marginTop: 8, padding: 8, borderRadius: 7, background: C.surface}},
            h('div', {style: {fontWeight: 600}}, 'AI 推荐理由'),
            loadedDraft.summary ? h('div', {style: small}, loadedDraft.summary) : null,
            ...loadedDraft.selected.map(item => h('div', {key: item.stepId, style: {...small, marginTop: 4}}, `${item.stepName} · ${item.displayName}${item.reason ? `：${item.reason}` : ''}`)),
          ) : null,
          workspace?.steps.map(step => h('div', {key: step.id, style: {marginTop: 10}},
            h('div', {style: {fontWeight: 600}}, `${step.name || step.id}${step.optional ? ' · 可选' : ' · 必需'}`),
            h('div', {style: small}, step.description || step.capability),
            h('div', {style: {...small, marginTop: 2}}, `为什么有这一步：${step.why || '满足工作台中的一项能力。'}`),
            ...(step.pluginChoicesInfo || []).map(plugin => pluginCard(plugin, selections[step.id] === plugin.package, () => setSelections(current => ({...current, [step.id]: plugin.package})))),
            step.optional ? h('div', {style: {marginTop: 5}}, h(Button, {onClick: () => setSelections(current => ({...current, [step.id]: undefined}))}, selections[step.id] ? '取消选择此步骤' : '保持不添加')) : null,
          )) || null,
          h('div', {style: {marginTop: 10}}, h(Button, {primary: true, disabled: busy || !workspace, onClick: preview}, busy ? '生成中…' : '预览工作台方案')),
        ),
        plan ? h(Card, null,
          h('div', {style: {fontWeight: 650}}, '安装方案预览'),
          h('div', {style: small}, `目标 profile：${plan.plan.target.profile} · 安装前将自动创建恢复点`),
          plan.plan.operations.length ? plan.plan.operations.map(operation => h('div', {key: operation.package, style: {marginTop: 8}}, h('div', {style: {fontWeight: 600}}, operation.spec), h('code', {style: {...small, overflowWrap: 'anywhere'}}, operation.argv.join(' ')))) : h('div', {style: {...small, marginTop: 8}}, '当前选择无需新增插件。'),
          ...plan.plan.warnings.map((warning, index) => h('div', {key: index, style: {...small, color: '#a66b00', marginTop: 6}}, warning.message)),
          plan.plan.operations.length && meta?.canApply ? h('div', {style: {marginTop: 10}}, h(Button, {primary: true, disabled: busy, onClick: applyPlan}, busy ? '正在安装…' : '创建恢复点并安装')) : null,
        ) : null,
        message ? h('div', {style: {...small, color: '#17803d', marginTop: 9, overflowWrap: 'anywhere'}}, message) : null,
        error ? h('div', {style: {color: C.danger, marginTop: 9, overflowWrap: 'anywhere'}}, error) : null,
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
        ctx.inject(['sessions', 'workspaces', 'conversation'], scope => {
          const sessions = (scope.get && scope.get('sessions')) || scope.sessions
          const workspaces = (scope.get && scope.get('workspaces')) || scope.workspaces
          const reader = sessionId => {
            const scoped = sessions?.scope?.(sessionId)
            const conversation = scoped?.get?.('conversation')
            const input = conversation?.input?.for?.(scoped)
            return input && typeof input.setDraft === 'function' && typeof input.submit === 'function' ? input : null
          }
          composerFor = reader
          const startDedicatedSession = async () => {
            if (!sessions?.list?.getSnapshot || typeof workspaces?.startSession !== 'function') throw new Error('sessions/workspaces service unavailable')
            const beforeSnapshot = sessions.list.getSnapshot()
            const before = beforeSnapshot.current
            const workspaceSnapshot = workspaces.list?.getSnapshot?.()
            const currentWorkspace = before && workspaceSnapshot?.items?.find(item => item.sessionIds?.includes(before))
            const targetWorkspaceId = currentWorkspace?.workspaceId || workspaceSnapshot?.recentWorkspaceId
            const targetWorkspace = workspaceSnapshot?.items?.find(item => item.workspaceId === targetWorkspaceId)
            const archived = workspaceSnapshot?.archivedSessionIds || []
            const reusableBlank = targetWorkspace && beforeSnapshot.ids.find(id => {
              const summary = beforeSnapshot.byId?.[id]
              return summary?.blank && summary.cwd === targetWorkspace.path && targetWorkspace.sessionIds.includes(id) && !archived.includes(id)
            })
            workspaces.startSession()
            if (before && reusableBlank === before) {
              await new Promise(resolve => setTimeout(resolve, 100))
              const snapshot = sessions.list.getSnapshot()
              if (snapshot.current === before && reader(before)) return before
            }
            let selected = null
            const deadline = Date.now() + 12000
            while (Date.now() < deadline) {
              const snapshot = sessions.list.getSnapshot()
              const current = snapshot.current
              const summary = current ? snapshot.byId?.[current] : null
              if (current && summary?.blank && current !== before) { selected = current; break }
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            if (!selected && before) {
              const snapshot = sessions.list.getSnapshot()
              if (snapshot.current === before && snapshot.byId?.[before]?.blank) selected = before
            }
            if (!selected) throw new Error('DSH 没有在 12 秒内打开新的空白会话；原有对话未修改。')
            const composerDeadline = Date.now() + 5000
            while (Date.now() < composerDeadline) {
              if (reader(selected)) return selected
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            throw new Error('新会话已打开，但 DSH 输入框尚未就绪；原有对话未修改。')
          }
          startSelectionSession = startDedicatedSession
          if (scope.effect) scope.effect(() => () => {
            if (composerFor === reader) composerFor = null
            if (startSelectionSession === startDedicatedSession) startSelectionSession = null
          }, 'dsh-diy: isolated composer')
        })
      } catch (error) { console.warn('[dsh-diy] isolated conversation input unavailable', error) }
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
