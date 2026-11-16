import {validateTargetProfile} from './schema.js'
import {randomUUID} from 'node:crypto'
import semver from 'semver'

export function buildApplyPlan(catalog, workspace, {profile, installed = [], dshVersion = null} = {}) {
  validateTargetProfile(profile)
  const installedSet = new Set(installed)
  const records = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
  for (const plugin of catalog.pluginDirectory?.plugins ?? []) {
    if (plugin.install?.bundle !== true || records.has(plugin.package)) continue
    records.set(plugin.package, {
      package: plugin.package,
      versionObserved: plugin.versionObserved,
      dsh: {bundle: true, ...(plugin.install.dshRange ? {engines: plugin.install.dshRange} : {}), ...(plugin.install.clientPlatform ? {clientPlatform: plugin.install.clientPlatform} : {})},
      evidence: {level: 'catalog-claim', source: plugin.evidence.source, workflowVerified: false},
      links: plugin.links,
    })
  }
  const operations = []
  const warnings = []

  for (const packageName of workspace.selectedPlugins) {
    const plugin = records.get(packageName)
    if (!plugin) throw new Error(`plugin is missing from catalog: ${packageName}`)
    if (!plugin.dsh.bundle) throw new Error(`plugin is not a DSH bundle: ${packageName}`)
    if (installedSet.has(packageName)) continue
    if (plugin.versionObserved && !semver.valid(plugin.versionObserved)) throw new Error(`${packageName} has an invalid observed version: ${plugin.versionObserved}`)
    const spec = plugin.versionObserved ? `${packageName}@${plugin.versionObserved}` : packageName
    operations.push({
      kind: 'install-dsh-bundle',
      package: packageName,
      spec,
      observedVersion: plugin.versionObserved,
      argv: ['dsh', 'plugin', '--profile', profile, 'add', spec],
      evidence: plugin.evidence,
    })
    if (plugin.evidence.level !== 'workflow-verified') {
      warnings.push({code: 'workflow-not-verified', package: packageName, message: `${packageName} 的端到端工作流尚未验证`})
    }
    if (plugin.dsh.engines && !dshVersion) {
      warnings.push({code: 'dsh-version-not-checked', package: packageName, message: `尚未对 ${packageName} 检查当前 DSH 版本`})
    }
    if (!plugin.platforms) {
      warnings.push({code: 'platform-not-verified', package: packageName, message: `目录未提供 ${packageName} 的完整平台验证信息`})
    }
    if (!plugin.versionObserved) {
      warnings.push({code: 'version-not-pinned', package: packageName, message: `${packageName} 没有目录观察版本；安装时将由 npm 解析当前版本`})
    }
  }

  return {
    id: `plan-${randomUUID()}`,
    status: 'preview-only',
    catalogAsOf: catalog.metadata.asOf,
    target: {profile, dshVersion},
    workspace: {id: workspace.id, layers: workspace.layers},
    operations,
    manualSteps: [],
    warnings,
    rollback: {supported: false, description: '当前版本只生成计划，不执行安装或自动回滚。'},
    createdAt: new Date().toISOString(),
  }
}
