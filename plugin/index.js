import {buildApplyPlan, createProfileBackup, listProfileBackups, listWorkspaces, loadCatalog, loadWorkspace, readProfileBackup, recommendPlugins, resolveWorkspace, restoreProfileFiles} from '../src/index.js'
import {randomUUID} from 'node:crypto'

export const name = 'dsh-diy'
export const inject = []

const BASE = '/api-dsh-diy'
const JSON_TYPE = 'application/json; charset=utf-8'
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[0-9][a-z0-9.+-]*)?$/i
const workspaceDrafts = new Map()

function sendJson(res, status, payload) {
  res.writeHead(status, {'content-type': JSON_TYPE, 'cache-control': 'no-store'})
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise(resolve => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 16 * 1024) {
        resolve({error: 'request-too-large'})
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve({error: 'invalid-json'}) }
    })
    req.on('error', () => resolve({error: 'request-failed'}))
  })
}

function safePost(req) {
  if (req.method !== 'POST' || !String(req.headers['content-type'] || '').startsWith('application/json')) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function service(scope, name) {
  return (scope.get && scope.get(name)) || scope[name]
}

function managerError(result) {
  if (!(result && (result.application === 'failed' || result.application === 'cancelled' || result.error))) return ''
  const code = result.error?.code || result.application || 'failed'
  const detail = String(result.error?.diagnostic || result.packageResult?.output || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)
  return detail ? `${code}: ${detail}` : code
}

function restoreCommand(profile) {
  return `dsh plugin --profile ${profile} install --frozen-lockfile`
}

function currentProfile(ctx) {
  try { return ctx.get('profileContext')?.name || null } catch { return null }
}

async function installedBundleNames(pluginManager) {
  try {
    const rows = await pluginManager?.listBundles?.()
    return Array.isArray(rows) ? rows.filter(row => row?.name && row.installed !== false).map(row => row.name) : null
  } catch {
    return null
  }
}

async function createWorkspaceDraft(args, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256) {
    throw new Error('无法识别当前 DSH 对话，草案没有保存。')
  }
  const workspaceId = String(args.workspace || '')
  const catalog = await loadCatalog()
  const recipe = await loadWorkspace(workspaceId, catalog)
  const selections = args.selections && typeof args.selections === 'object' && !Array.isArray(args.selections) ? args.selections : {}
  for (const [stepId, packageName] of Object.entries(selections)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(stepId) || typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName)) {
      throw new Error('工作台草案中的步骤或插件格式无效。')
    }
  }
  const resolved = await resolveWorkspace(catalog, workspaceId, {selections})
  const reasons = args.stepReasons && typeof args.stepReasons === 'object' && !Array.isArray(args.stepReasons) ? args.stepReasons : {}
  const stepById = new Map(resolved.steps.map(step => [step.id, step]))
  const byPackage = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
  const selected = resolved.steps.filter(step => step.enabled).map(step => {
    const plugin = byPackage.get(step.selectedPlugin)
    const reason = typeof reasons[step.id] === 'string' ? reasons[step.id].trim().slice(0, 600) : ''
    return {stepId: step.id, stepName: step.name || step.id, package: plugin.package, displayName: plugin.displayName || plugin.package, reason}
  })
  for (const stepId of Object.keys(reasons)) if (!stepById.has(stepId)) throw new Error(`未知的工作台步骤：${stepId}`)
  const summary = String(args.summary || '').trim().slice(0, 1200)
  const createdAt = new Date()
  for (const [key, item] of workspaceDrafts) if (Date.parse(item.expiresAt) <= createdAt.getTime()) workspaceDrafts.delete(key)
  const draft = {
    id: randomUUID(),
    status: 'ready',
    sessionId,
    workspace: {id: recipe.id, name: recipe.name.zh || recipe.name.en, description: recipe.description.zh || recipe.description.en},
    selections: Object.fromEntries(resolved.steps.filter(step => step.enabled).map(step => [step.id, step.selectedPlugin])),
    selected,
    summary,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
  }
  workspaceDrafts.set(sessionId, draft)
  return {id: draft.id, status: draft.status, workspace: draft.workspace, selections: draft.selections, selected: draft.selected, summary: draft.summary, createdAt: draft.createdAt, expiresAt: draft.expiresAt, message: '已把工作台草案送到 DSH DIY 右侧面板。该草案不会安装插件；需要用户在面板检查、调整并预览。'}
}

async function registerDiyTools(tools) {
  if (!tools || typeof tools.register !== 'function') return
  let defineTool = tool => tool
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    defineTool = module.defineTool || defineTool
  } catch { /* A plain tool definition is accepted by older DSH builds. */ }

  const json = {type: 'json'}
  const definitions = [
    {
      name: 'diy_recommend',
      description: '按用户目标在 DSH DIY 目录中找插件候选，并返回人类可读的功能、适用场景、优缺点与验证状态。目录匹配只是证据，必须结合用户需求解释取舍，不能把未验证说成可运行组合。',
      parameters: {
        goal: {type: 'string', required: true, description: '用户希望完成的具体工作'},
        limit: {type: 'integer', description: '最多返回候选数，默认 8'},
      },
      output: {
        schema: json,
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value, null, 2)}],
      },
      async execute(args) {
        const catalog = await loadCatalog()
        const result = recommendPlugins(catalog, String(args.goal || ''), {limit: args.limit})
        const byPackage = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
        return {...result, candidates: result.candidates.map(candidate => {
          const plugin = byPackage.get(candidate.package)
          return {...candidate,
            displayName: plugin.displayName || candidate.package,
            whatItDoes: plugin.whatItDoes || candidate.summary,
            bestFor: plugin.bestFor || '目录未提供明确适用场景',
            tradeoffs: plugin.tradeoffs || '目录未提供已核实的限制信息',
            recommendation: plugin.recommendation || '',
            evidenceLabel: ({'catalog-claim': '目录声明，尚未由 DIY 单独验证', 'metadata-reviewed': '已检查元数据，未验证完整流程', 'install-verified': '单插件安装已验证', 'workflow-verified': '端到端流程已验证'})[candidate.evidence.level] || '验证状态未知',
            compatibilityLabel: candidate.compatibility === 'unknown' ? '当前 DSH 版本和平台兼容性未核实' : candidate.compatibility === 'compatible' ? 'DSH 版本范围匹配；平台仍需确认' : '不兼容',
          }
        })}
      },
    },
    {
      name: 'diy_workspaces',
      description: '列出 DSH DIY 的通用工作台和场景预设。用户想搭建 DSH 工作台时调用。',
      parameters: {},
      output: {
        schema: json,
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value, null, 2)}],
      },
      async execute() {
        const catalog = await loadCatalog()
        const plugins = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
        const workspaces = await listWorkspaces()
        return Promise.all(workspaces.map(async item => {
          const recipe = await loadWorkspace(item.id, catalog)
          return {...item,
            defaultPlugins: recipe.defaultPlugins,
            steps: recipe.steps.map(step => ({
              id: step.id,
              name: step.name || step.id,
              description: step.description || '',
              why: step.why || '',
              optional: step.optional,
              choices: step.pluginChoices.map(packageName => {
                const plugin = plugins.get(packageName)
                return {package: packageName, displayName: plugin.displayName || packageName, summary: plugin.summary.zh || plugin.summary.en, bestFor: plugin.bestFor || '', tradeoffs: plugin.tradeoffs || '', evidence: plugin.evidence.level}
              }),
            })),
          }
        }))
      },
    },
    {
      name: 'diy_submit_workspace_draft',
      description: '用户确认推荐组合后调用，把工作台 ID、每一步选中的目录插件、逐步理由和总结送到当前会话的 DSH DIY 右侧面板。只保存待确认草案，不安装插件、不修改 profile。必需步骤必须有选择，可选步骤可省略。',
      parameters: {
        workspace: {type: 'string', required: true, description: 'diy_workspaces 返回的工作台 id，例如 video-creator'},
        selections: {type: 'json', required: true, description: 'JSON 对象：步骤 id 到插件 package 的映射，只允许当前工作台目录中的候选'},
        summary: {type: 'string', description: '中文概括选择理由和未覆盖需求'},
        stepReasons: {type: 'json', description: 'JSON 对象：步骤 id 到推荐理由的映射'},
      },
      output: {
        schema: json,
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value, null, 2)}],
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id || exec?.agent?.session?.id
        return createWorkspaceDraft(args, sessionId)
      },
    },
  ]

  for (const definition of definitions) await tools.register(defineTool(definition))
}

function registerRoutes(ctx, webServer, getPluginManager) {
  const route = (path, handler) => webServer.register({kind: 'exact', path: `${BASE}${path}`, handler})
  const profile = currentProfile(ctx)

  route('/meta', async (req, res) => {
    const catalog = await loadCatalog()
    const pluginManager = getPluginManager()
    const installed = await installedBundleNames(pluginManager)
    sendJson(res, 200, {
      name: 'dsh-diy',
      version: '0.0.4',
      profile,
      catalogAsOf: catalog.metadata.asOf,
      pluginCount: catalog.plugins.length,
      workspaceCount: (await listWorkspaces()).length,
      installedKnown: installed !== null,
      canManageCurrentProfile: Boolean(pluginManager && typeof pluginManager.installBundle === 'function'),
      canRestoreFiles: true,
      canApply: Boolean(pluginManager && typeof pluginManager.installBundle === 'function'),
    })
  })

  route('/workspaces', async (_req, res) => sendJson(res, 200, await listWorkspaces()))

  route('/draft', async (req, res) => {
    const sessionId = new URL(req.url, 'http://dsh.local').searchParams.get('sessionId') || ''
    if (!sessionId || sessionId.length > 256) return sendJson(res, 400, {error: 'valid sessionId is required'})
    const draft = workspaceDrafts.get(sessionId)
    if (!draft) return sendJson(res, 200, null)
    if (Date.parse(draft.expiresAt) <= Date.now()) {
      workspaceDrafts.delete(sessionId)
      return sendJson(res, 200, null)
    }
    const {sessionId: _sessionId, ...publicDraft} = draft
    sendJson(res, 200, publicDraft)
  })

  route('/draft/ack', async (req, res) => {
    if (!safePost(req)) return sendJson(res, 403, {error: 'same-origin JSON POST required'})
    const body = await readJsonBody(req)
    if (body.error) return sendJson(res, 400, {error: body.error})
    const sessionId = String(body.sessionId || '')
    const draft = workspaceDrafts.get(sessionId)
    if (!draft || draft.id !== body.draftId) return sendJson(res, 404, {error: '草案不存在或已更新'})
    workspaceDrafts.delete(sessionId)
    sendJson(res, 200, {ok: true})
  })



  route('/workspace', async (req, res) => {
    try {
      const id = new URL(req.url, 'http://dsh.local').searchParams.get('id') || ''
      const catalog = await loadCatalog()
      const workspace = await loadWorkspace(id, catalog)
      const byPackage = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
      sendJson(res, 200, {...workspace, steps: workspace.steps.map(step => ({...step, pluginChoicesInfo: step.pluginChoices.map(packageName => byPackage.get(packageName)).filter(Boolean)}))})
    } catch (error) {
      sendJson(res, 400, {error: error.message})
    }
  })

  route('/recommend', async (req, res) => {
    if (!safePost(req)) return sendJson(res, 403, {error: 'same-origin JSON POST required'})
    const body = await readJsonBody(req)
    if (body.error) return sendJson(res, 400, {error: body.error})
    if (typeof body.goal !== 'string' || body.goal.trim().length < 2 || body.goal.length > 500) {
      return sendJson(res, 400, {error: 'goal must be between 2 and 500 characters'})
    }
    try {
      const catalog = await loadCatalog()
      const result = recommendPlugins(catalog, body.goal, {limit: body.limit})
      const byPackage = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
      sendJson(res, 200, {...result, candidates: result.candidates.map(candidate => {
        const plugin = byPackage.get(candidate.package)
        return {...candidate,
          displayName: plugin.displayName || candidate.package,
          whatItDoes: plugin.whatItDoes || plugin.summary,
          bestFor: plugin.bestFor || '目录未提供明确适用场景',
          tradeoffs: plugin.tradeoffs || '目录未提供已核实的限制信息',
          recommendation: plugin.recommendation || '',
          evidenceLabel: ({'catalog-claim': '目录声明，尚未由 DIY 单独验证', 'metadata-reviewed': '已检查元数据，未验证完整流程', 'install-verified': '单插件安装已验证', 'workflow-verified': '端到端流程已验证'})[candidate.evidence.level] || '验证状态未知',
          compatibilityLabel: candidate.compatibility === 'unknown' ? '当前 DSH 版本和平台兼容性未核实' : candidate.compatibility === 'compatible' ? 'DSH 版本范围匹配；平台仍需确认' : '不兼容',
        }
      })})
    } catch (error) {
      sendJson(res, 500, {error: error.message})
    }
  })

  route('/plan', async (req, res) => {
    if (!safePost(req)) return sendJson(res, 403, {error: 'same-origin JSON POST required'})
    const body = await readJsonBody(req)
    if (body.error) return sendJson(res, 400, {error: body.error})
    if (typeof body.workspace !== 'string' || !body.selections || typeof body.selections !== 'object' || Array.isArray(body.selections)) {
      return sendJson(res, 400, {error: 'workspace and selections are required'})
    }
    for (const [stepId, packageName] of Object.entries(body.selections)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(stepId) || typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName)) {
        return sendJson(res, 400, {error: 'invalid step selection'})
      }
    }
    if (!profile) return sendJson(res, 409, {error: 'current DSH profile is unavailable'})
    try {
      const catalog = await loadCatalog()
      const recipe = await loadWorkspace(body.workspace, catalog)
      const resolved = await resolveWorkspace(catalog, body.workspace, {selections: body.selections})
      const installed = await installedBundleNames(getPluginManager()) || []
      const plan = buildApplyPlan(catalog, resolved, {profile, installed})
      sendJson(res, 200, {catalogAsOf: catalog.metadata.asOf, recipe, resolved, plan})
    } catch (error) {
      sendJson(res, 400, {error: error.message})
    }
  })

  route('/backups', async (_req, res) => {
    if (!profile) return sendJson(res, 409, {error: '当前 DSH profile 不可用'})
    try { sendJson(res, 200, await listProfileBackups(profile)) }
    catch (error) { sendJson(res, 500, {error: error.message}) }
  })

  route('/backup', async (req, res) => {
    if (!safePost(req)) return sendJson(res, 403, {error: 'same-origin JSON POST required'})
    if (!profile) return sendJson(res, 409, {error: '当前 DSH profile 不可用'})
    try { sendJson(res, 201, await createProfileBackup(profile)) }
    catch (error) { sendJson(res, 500, {error: `创建恢复点失败：${error.message}`}) }
  })

  route('/restore', async (req, res) => {
    if (!safePost(req)) return sendJson(res, 403, {error: 'same-origin JSON POST required'})
    const body = await readJsonBody(req)
    if (body.error) return sendJson(res, 400, {error: body.error})
    if (!profile || typeof body.backupId !== 'string') return sendJson(res, 400, {error: 'backupId and current profile are required'})
    try {
      await readProfileBackup(profile, body.backupId)
      const recoveryPoint = await createProfileBackup(profile)
      const restored = await restoreProfileFiles(profile, body.backupId)
      sendJson(res, 200, {...restored, recoveryPoint, command: restoreCommand(profile), note: '已恢复 profile 配置文件；完全退出并重启 DSH 后，再执行冻结安装命令以还原插件依赖。'})
    } catch (error) { sendJson(res, 400, {error: `恢复失败：${error.message}`}) }
  })

  route('/apply', async (req, res) => {
    if (!safePost(req)) return sendJson(res, 403, {error: 'same-origin JSON POST required'})
    const body = await readJsonBody(req)
    if (body.error) return sendJson(res, 400, {error: body.error})
    if (!profile || typeof body.workspace !== 'string' || !body.selections || typeof body.selections !== 'object' || Array.isArray(body.selections)) {
      return sendJson(res, 400, {error: 'workspace and selections are required'})
    }
    for (const [stepId, packageName] of Object.entries(body.selections)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(stepId) || typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName)) {
        return sendJson(res, 400, {error: 'invalid step selection'})
      }
    }
    const manager = getPluginManager()
    if (!manager || typeof manager.installBundle !== 'function') return sendJson(res, 409, {error: '当前 DSH 版本不支持面板内安装，请使用方案中的 CLI 命令'})
    try {
      const catalog = await loadCatalog()
      const recipe = await loadWorkspace(body.workspace, catalog)
      const resolved = await resolveWorkspace(catalog, body.workspace, {selections: body.selections})
      const installedBefore = await installedBundleNames(manager) || []
      const plan = buildApplyPlan(catalog, resolved, {profile, installed: installedBefore})
      if (!plan.operations.length) return sendJson(res, 200, {status: 'already-installed', plan, message: '当前选择的插件已安装，无需变更。'})
      const recoveryPoint = await createProfileBackup(profile)
      const completed = []
      for (const operation of plan.operations) {
        let result
        let error
        try {
          result = await manager.installBundle(operation.spec, {enabled: true})
          error = managerError(result)
        } catch (failure) { error = failure.message || String(failure) }
        if (error) {
          const rollback = []
          for (const item of [...completed].reverse()) {
            if (typeof manager.removeBundle !== 'function') { rollback.push({package: item.package, ok: false, error: 'DSH 不支持自动卸载'}); continue }
            try {
              const removeResult = await manager.removeBundle(item.package)
              const removeError = managerError(removeResult)
              rollback.push({package: item.package, ok: !removeError, error: removeError || undefined})
            } catch (failure) { rollback.push({package: item.package, ok: false, error: failure.message}) }
          }
          let filesRestored = false
          let restoreError = ''
          try { await restoreProfileFiles(profile, recoveryPoint.id); filesRestored = true }
          catch (failure) { restoreError = failure.message }
          return sendJson(res, 502, {error: `安装 ${operation.package} 失败：${error}`, recoveryPoint, completed: completed.map(item => item.package), rollback, profileFilesRestored: filesRestored, restoreError: restoreError || undefined, restoreCommand: restoreCommand(profile)})
        }
        completed.push(operation)
      }
      sendJson(res, 200, {status: 'applied', recoveryPoint, installed: completed.map(item => item.package), restartRequired: true, message: '插件已加入当前 profile。完全退出并重启 DSH 后生效；恢复点可在本页回滚配置。', recipe})
    } catch (error) { sendJson(res, 400, {error: error.message}) }
  })
}

export function apply(ctx) {
  let pluginManager = null
  ctx.inject(['pluginManager'], scope => { pluginManager = service(scope, 'pluginManager') })
  ctx.inject(['tools'], scope => {
    registerDiyTools(service(scope, 'tools')).catch(error => console.warn('[dsh-diy] tool registration failed', error))
  })
  ctx.inject(['webServer'], scope => {
    const webServer = service(scope, 'webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    try { registerRoutes(ctx, webServer, () => pluginManager) }
    catch (error) { console.warn('[dsh-diy] route registration failed', error) }
  })
}

export default {name, inject, apply}
