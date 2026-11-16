import {loadWorkspaceChain} from './catalog.js'

export async function resolveWorkspace(catalog, workspaceId, {selections = {}, disabledSteps = []} = {}) {
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
  const selectedPlugins = [...new Set([
    ...defaults,
    ...resolvedSteps.filter(step => step.enabled).map(step => step.selectedPlugin),
  ])]
  return {
    id: workspaceId,
    layers: layers.map(layer => ({id: layer.id, version: layer.version})),
    steps: resolvedSteps,
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
