const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)+$/
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value
}

function string(value, path) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}

function stringArray(value, path, { pattern } = {}) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  value.forEach((item, index) => {
    string(item, `${path}[${index}]`)
    if (pattern && !pattern.test(item)) throw new Error(`${path}[${index}] has an invalid value`)
  })
  if (new Set(value).size !== value.length) throw new Error(`${path} must not contain duplicates`)
  return value
}

function localized(value, path) {
  object(value, path)
  if (value.zh !== undefined) string(value.zh, `${path}.zh`)
  if (value.en !== undefined) string(value.en, `${path}.en`)
  if (value.zh === undefined && value.en === undefined) throw new Error(`${path} must have a zh or en value`)
}

export function validateCatalog(catalog) {
  object(catalog, 'catalog')
  if (catalog.schemaVersion !== 1) throw new Error('catalog.schemaVersion must be 1')
  object(catalog.metadata, 'catalog.metadata')
  string(catalog.metadata.id, 'catalog.metadata.id')
  string(catalog.metadata.asOf, 'catalog.metadata.asOf')
  if (!Array.isArray(catalog.capabilities) || !Array.isArray(catalog.plugins)) {
    throw new Error('catalog.capabilities and catalog.plugins must be arrays')
  }

  const capabilityIds = new Set()
  for (const [index, capability] of catalog.capabilities.entries()) {
    const path = `catalog.capabilities[${index}]`
    object(capability, path)
    string(capability.id, `${path}.id`)
    if (!CAPABILITY_ID.test(capability.id)) throw new Error(`${path}.id is invalid`)
    if (capabilityIds.has(capability.id)) throw new Error(`duplicate capability id: ${capability.id}`)
    capabilityIds.add(capability.id)
    localized(capability.name, `${path}.name`)
    string(capability.description, `${path}.description`)
    stringArray(capability.aliases, `${path}.aliases`)
  }

  const pluginIds = new Set()
  for (const [index, plugin] of catalog.plugins.entries()) {
    const path = `catalog.plugins[${index}]`
    object(plugin, path)
    string(plugin.id, `${path}.id`)
    string(plugin.package, `${path}.package`)
    if (!PACKAGE_NAME.test(plugin.package)) throw new Error(`${path}.package is invalid`)
    if (plugin.id !== plugin.package) throw new Error(`${path}.id must match ${path}.package`)
    if (pluginIds.has(plugin.id)) throw new Error(`duplicate plugin id: ${plugin.id}`)
    pluginIds.add(plugin.id)
    localized(plugin.summary, `${path}.summary`)
    stringArray(plugin.capabilities, `${path}.capabilities`, {pattern: CAPABILITY_ID})
    object(plugin.dsh, `${path}.dsh`)
    if (typeof plugin.dsh.bundle !== 'boolean') throw new Error(`${path}.dsh.bundle must be boolean`)
    if (plugin.dsh.engines !== undefined) string(plugin.dsh.engines, `${path}.dsh.engines`)
    if (plugin.dsh.clientPlatform !== undefined) string(plugin.dsh.clientPlatform, `${path}.dsh.clientPlatform`)
    object(plugin.evidence, `${path}.evidence`)
    if (!['catalog-claim', 'metadata-reviewed', 'install-verified', 'workflow-verified'].includes(plugin.evidence.level)) {
      throw new Error(`${path}.evidence.level is invalid`)
    }
    if (typeof plugin.evidence.workflowVerified !== 'boolean') throw new Error(`${path}.evidence.workflowVerified must be boolean`)
  }

  for (const plugin of catalog.plugins) {
    for (const capability of plugin.capabilities) {
      if (!capabilityIds.has(capability)) throw new Error(`${plugin.package} references unknown capability ${capability}`)
    }
  }
  return catalog
}

export function validateWorkspace(workspace, catalog) {
  object(workspace, 'workspace')
  if (workspace.schemaVersion !== 1) throw new Error('workspace.schemaVersion must be 1')
  string(workspace.id, 'workspace.id')
  if (!IDENTIFIER.test(workspace.id)) throw new Error('workspace.id is invalid')
  if (!Number.isInteger(workspace.version) || workspace.version < 1) throw new Error('workspace.version must be a positive integer')
  localized(workspace.name, 'workspace.name')
  localized(workspace.description, 'workspace.description')
  stringArray(workspace.extends, 'workspace.extends', {pattern: IDENTIFIER})
  stringArray(workspace.defaultPlugins, 'workspace.defaultPlugins', {pattern: PACKAGE_NAME})
  if (!Array.isArray(workspace.steps)) throw new Error('workspace.steps must be an array')

  const capabilityIds = new Set(catalog.capabilities.map(item => item.id))
  const pluginIds = new Set(catalog.plugins.map(item => item.package))
  const stepIds = new Set()
  for (const [index, step] of workspace.steps.entries()) {
    const path = `workspace.steps[${index}]`
    object(step, path)
    string(step.id, `${path}.id`)
    if (!IDENTIFIER.test(step.id) || stepIds.has(step.id)) throw new Error(`${path}.id is invalid or duplicated`)
    stepIds.add(step.id)
    string(step.capability, `${path}.capability`)
    if (!capabilityIds.has(step.capability)) throw new Error(`${path}.capability is unknown`)
    if (typeof step.optional !== 'boolean') throw new Error(`${path}.optional must be boolean`)
    if (step.selection !== 'choose-one') throw new Error(`${path}.selection must be choose-one`)
    stringArray(step.pluginChoices, `${path}.pluginChoices`, {pattern: PACKAGE_NAME})
    for (const plugin of step.pluginChoices) {
      if (!pluginIds.has(plugin)) throw new Error(`${path}.pluginChoices references unknown plugin ${plugin}`)
      const record = catalog.plugins.find(item => item.package === plugin)
      if (!record.capabilities.includes(step.capability)) {
        throw new Error(`${path} includes ${plugin}, which does not declare ${step.capability}`)
      }
    }
  }
  return workspace
}

export function validateTargetProfile(profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || profile === '.' || profile === '..') {
    throw new Error('profile must be 1-64 letters, numbers, dots, underscores, or hyphens')
  }
  return profile
}
