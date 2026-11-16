import semver from 'semver'

const normalize = value => String(value ?? '').toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '')

function terms(value) {
  const text = String(value ?? '').toLocaleLowerCase().normalize('NFKC')
  const latin = text.match(/[a-z0-9]+/g) ?? []
  const cjk = [...text.matchAll(/[\u3400-\u9fff]+/g)].flatMap(match => {
    const chars = [...match[0]]
    if (chars.length <= 2) return [match[0]]
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1])
  })
  return new Set([...latin, ...cjk])
}

function aliasScore(query, alias) {
  const q = normalize(query)
  const a = normalize(alias)
  if (!q || !a) return 0
  if (q === a) return 1
  if (q.includes(a) || a.includes(q)) return Math.min(q.length, a.length) >= 2 ? 0.9 : 0
  const left = terms(query)
  const right = terms(alias)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const term of left) if (right.has(term)) shared++
  return shared ? (shared / Math.max(left.size, right.size)) * 0.72 : 0
}

export function searchCapabilities(catalog, query, {limit = 8} = {}) {
  const text = String(query ?? '').trim()
  if (!text) return []
  const capById = new Map(catalog.capabilities.map(capability => [capability.id, capability]))
  return catalog.capabilities.map(capability => {
    const aliases = [capability.name.zh, capability.name.en, ...capability.aliases].filter(Boolean)
    const score = Math.max(...aliases.map(alias => aliasScore(text, alias)), 0)
    return {capability, score}
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 8)))
    .map(row => ({...row, capability: capById.get(row.capability.id)}))
}

function compatibility(plugin, environment) {
  const reasons = []
  let state = 'unknown'
  if (plugin.dsh.bundle !== true) return {state: 'incompatible', reasons: ['missing-dsh-bundle']}

  if (environment?.dshVersion && plugin.dsh.engines) {
    if (semver.valid(environment.dshVersion) && semver.validRange(plugin.dsh.engines)) {
      if (!semver.satisfies(environment.dshVersion, plugin.dsh.engines, {includePrerelease: true})) {
        return {state: 'incompatible', reasons: ['unsupported-dsh-version']}
      }
      state = 'compatible'
      reasons.push('dsh-version-range-matches')
    } else {
      reasons.push('dsh-version-range-unparsed')
    }
  } else {
    reasons.push(plugin.dsh.engines ? 'dsh-version-not-checked' : 'dsh-version-not-declared')
  }

  const platform = environment?.platform
  if (platform && Array.isArray(plugin.platforms)) {
    if (!plugin.platforms.includes(platform)) return {state: 'incompatible', reasons: ['unsupported-platform']}
    reasons.push('platform-matches-catalog')
  } else {
    reasons.push('platform-not-verified')
  }

  return {state, reasons}
}

export function recommendPlugins(catalog, query, {environment = {}, limit = 8} = {}) {
  const matches = searchCapabilities(catalog, query, {limit: 20})
  const matchedIds = new Set(matches.map(match => match.capability.id))
  if (!matchedIds.size) return {query, capabilities: [], candidates: [], missingCapabilities: [], catalogAsOf: catalog.metadata.asOf}

  const candidates = catalog.plugins.map(plugin => {
    const covered = plugin.capabilities.filter(id => matchedIds.has(id))
    const compatibilityResult = compatibility(plugin, environment)
    const capabilityNames = covered.map(id => {
      const capability = catalog.capabilities.find(item => item.id === id)
      return capability.name.zh || capability.name.en
    })
    const reasons = capabilityNames.map(name => `declares-${name}`)
    if (plugin.evidence.level === 'catalog-claim') reasons.push('capability-from-plugin-catalog-claim')
    if (!plugin.evidence.workflowVerified) reasons.push('workflow-not-verified')
    reasons.push(...compatibilityResult.reasons)
    return {
      package: plugin.package,
      summary: plugin.summary,
      versionObserved: plugin.versionObserved,
      capabilities: covered,
      capabilityNames,
      coverage: covered.length / matchedIds.size,
      evidence: plugin.evidence,
      compatibility: compatibilityResult.state,
      eligible: compatibilityResult.state !== 'incompatible',
      reasons,
      links: plugin.links,
    }
  }).filter(candidate => candidate.capabilities.length > 0)
    .sort((a, b) => Number(b.eligible) - Number(a.eligible)
      || b.capabilities.length - a.capabilities.length
      || evidenceRank(b.evidence.level) - evidenceRank(a.evidence.level)
      || a.package.localeCompare(b.package))
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 8)))

  const coveredIds = new Set(candidates.filter(row => row.eligible).flatMap(row => row.capabilities))
  const missingCapabilities = matches.filter(match => !coveredIds.has(match.capability.id)).map(match => match.capability.id)
  return {
    query,
    capabilities: matches.map(({capability, score}) => ({id: capability.id, name: capability.name, score})),
    candidates,
    missingCapabilities,
    catalogAsOf: catalog.metadata.asOf,
  }
}

function evidenceRank(level) {
  return ({'workflow-verified': 3, 'install-verified': 2, 'metadata-reviewed': 1, 'catalog-claim': 0})[level] ?? -1
}
