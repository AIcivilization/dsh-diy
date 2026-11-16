import {readFile} from 'node:fs/promises'
import {validateCatalog, validateWorkspace} from './schema.js'

const bundledCatalog = new URL('../../catalog/catalog.json', import.meta.url)
const bundledWorkspaces = new URL('../../catalog/workspaces/', import.meta.url)

export async function loadCatalog({catalogUrl = bundledCatalog} = {}) {
  const raw = JSON.parse(await readFile(catalogUrl, 'utf8'))
  return validateCatalog(raw)
}

export async function loadWorkspace(id, catalog, {workspaceDir = bundledWorkspaces} = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error('invalid workspace id')
  const file = new URL(`${id}.json`, workspaceDir)
  const raw = JSON.parse(await readFile(file, 'utf8'))
  if (raw.id !== id) throw new Error(`workspace id mismatch: expected ${id}, received ${raw.id}`)
  return validateWorkspace(raw, catalog)
}

export async function loadWorkspaceChain(id, catalog, options = {}, seen = new Set()) {
  if (seen.has(id)) throw new Error(`workspace inheritance cycle at ${id}`)
  seen.add(id)
  const workspace = await loadWorkspace(id, catalog, options)
  const parents = []
  for (const parentId of workspace.extends) {
    parents.push(...await loadWorkspaceChain(parentId, catalog, options, new Set(seen)))
  }
  return [...parents, workspace]
}

export async function listWorkspaces({workspaceDir = bundledWorkspaces} = {}) {
  const {readdir} = await import('node:fs/promises')
  const files = (await readdir(workspaceDir)).filter(file => file.endsWith('.json')).sort()
  const rows = []
  for (const file of files) {
    const raw = JSON.parse(await readFile(new URL(file, workspaceDir), 'utf8'))
    rows.push({id: raw.id, version: raw.version, name: raw.name, description: raw.description})
  }
  return rows
}
