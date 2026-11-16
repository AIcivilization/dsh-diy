import {buildApplyPlan, listWorkspaces, loadCatalog, loadWorkspace, recommendPlugins, resolveWorkspace} from '../src/index.js'

export const name = 'dsh-diy'
export const inject = []

const BASE = '/api-dsh-diy'
const JSON_TYPE = 'application/json; charset=utf-8'
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[0-9][a-z0-9.+-]*)?$/i

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
      description: '按用户想完成的目标，在 DSH DIY 目录里找能力和候选插件。只返回目录声明和验证状态，不要把未验证说成可运行组合。',
      parameters: {
        goal: {type: 'string', required: true, description: '用户希望完成的具体工作'},
        limit: {type: 'integer', description: '最多返回候选数，默认 8'},
      },
      output: {
        schema: json,
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value, null, 2)}],
      },
      async execute(args) {
        return recommendPlugins(await loadCatalog(), String(args.goal || ''), {limit: args.limit})
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
      async execute() { return listWorkspaces() },
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
      version: '0.0.1',
      profile,
      catalogAsOf: catalog.metadata.asOf,
      pluginCount: catalog.plugins.length,
      workspaceCount: (await listWorkspaces()).length,
      installedKnown: installed !== null,
      canManageCurrentProfile: Boolean(pluginManager && typeof pluginManager.installBundle === 'function'),
    })
  })

  route('/workspaces', async (_req, res) => sendJson(res, 200, await listWorkspaces()))

  route('/workspace', async (req, res) => {
    try {
      const id = new URL(req.url, 'http://dsh.local').searchParams.get('id') || ''
      const catalog = await loadCatalog()
      sendJson(res, 200, await loadWorkspace(id, catalog))
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
      sendJson(res, 200, recommendPlugins(await loadCatalog(), body.goal, {limit: body.limit}))
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
