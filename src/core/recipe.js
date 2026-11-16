import {loadWorkspaceChain} from './catalog.js'

export async function resolveWorkspace(catalog, workspaceId, {selections = {}, disabledSteps = [], additionalSteps = []} = {}) {
  const layers = await loadWorkspaceChain(workspaceId, catalog)
  const steps = new Map()
  const defaults = new Set()
  for (const layer of layers) {
    for (const plugin of layer.defaultPlugins) defaults.add(plugin)
    for (const step of layer.steps) steps.set(step.id, {...step, sourceWorkspace: layer.id})
  }

  const resolvedSteps = [...steps.values()].map(step => {
    const selectedPlugin = selections[step.id] ?? null
    const disabled = disabledSteps.includes(step.id)
    if (disabled && !step.optional) throw new Error(`required step cannot be disabled: ${step.id}`)
    if (selectedPlugin && !step.pluginChoices.includes(selectedPlugin)) {
      throw new Error(`${selectedPlugin} is not a choice for step ${step.id}`)
    }
    const enabled = !disabled && (!step.optional || selectedPlugin !== null)
    if (enabled && !selectedPlugin) throw new Error(`choose a plugin for required step ${step.id}`)
    return {...step, enabled, selectedPlugin}
  })
  if (!Array.isArray(additionalSteps) || additionalSteps.length > 12) throw new Error('additionalSteps must contain at most 12 proposed steps')
  const ids = new Set(resolvedSteps.map(step => step.id))
  const directory = new Map((catalog.pluginDirectory?.plugins ?? []).map(plugin => [plugin.package, plugin]))
  const proposedSteps = additionalSteps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`additionalSteps[${index}] must be an object`)
    const {id, name, capability, package: packageName, reason = ''} = step
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || ids.has(id)) throw new Error(`additionalSteps[${index}].id is invalid or duplicated`)
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error(`additionalSteps[${index}].name is invalid`)
    if (typeof capability !== 'string' || !capability.trim() || capability.length > 160) throw new Error(`additionalSteps[${index}].capability is invalid`)
    if (typeof reason !== 'string' || reason.length > 600) throw new Error(`additionalSteps[${index}].reason is invalid`)
    const plugin = directory.get(packageName)
    if (!plugin || plugin.install?.bundle !== true) throw new Error(`additionalSteps[${index}] references an undiscovered or non-bundle package`)
    ids.add(id)
    return {id, name: name.trim(), capability: capability.trim(), description: capability.trim(), why: reason.trim(), optional: false, selection: 'choose-one', pluginChoices: [packageName], enabled: true, selectedPlugin: packageName, sourceWorkspace: 'ai-proposed', evidence: plugin.evidence}
  })
  const selectedPlugins = [...new Set([
    ...defaults,
    ...resolvedSteps.filter(step => step.enabled).map(step => step.selectedPlugin),
    ...proposedSteps.map(step => step.selectedPlugin),
  ])]
  return {
    id: workspaceId,
    layers: layers.map(layer => ({id: layer.id, version: layer.version})),
    steps: [...resolvedSteps, ...proposedSteps],
    selectedPlugins,
  }
}

export function diffWorkspace(before, after) {
  const oldSteps = new Map(before.steps.map(step => [step.id, step]))
  const newSteps = new Map(after.steps.map(step => [step.id, step]))
  const changes = []
  for (const [id, previous] of oldSteps) {
    const next = newSteps.get(id)
    if (!next) changes.push({stepId: id, kind: 'removed', before: previous.selectedPlugin ?? null, after: null})
    else if (previous.selectedPlugin !== next.selectedPlugin || previous.enabled !== next.enabled) {
      changes.push({stepId: id, kind: 'changed', before: previous.selectedPlugin ?? null, after: next.selectedPlugin ?? null})
    }
  }
  for (const [id, next] of newSteps) {
    if (!oldSteps.has(id)) changes.push({stepId: id, kind: 'added', before: null, after: next.selectedPlugin ?? null})
  }
  const beforePlugins = new Set(before.selectedPlugins)
  const afterPlugins = new Set(after.selectedPlugins)
  return {
    changes,
    addPlugins: [...afterPlugins].filter(plugin => !beforePlugins.has(plugin)),
    removePlugins: [...beforePlugins].filter(plugin => !afterPlugins.has(plugin)),
  }
}
