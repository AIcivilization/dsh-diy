import {validateTargetProfile} from './schema.js'
import {randomUUID} from 'node:crypto'

export function buildApplyPlan(catalog, workspace, {profile, installed = [], dshVersion = null} = {}) {
  validateTargetProfile(profile)
  const installedSet = new Set(installed)
  const records = new Map(catalog.plugins.map(plugin => [plugin.package, plugin]))
  const operations = []
  const warnings = []

  for (const packageName of workspace.selectedPlugins) {
    const plugin = records.get(packageName)
    if (!plugin) throw new Error(`plugin is missing from catalog: ${packageName}`)
    if (!plugin.dsh.bundle) throw new Error(`plugin is not a DSH bundle: ${packageName}`)
    if (installedSet.has(packageName)) continue
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
