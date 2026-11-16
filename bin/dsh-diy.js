#!/usr/bin/env node

import {buildApplyPlan, listWorkspaces, loadCatalog, loadWorkspace, recommendPlugins, resolveWorkspace} from '../src/index.js'

const [command = 'help', ...args] = process.argv.slice(2)

function optionValues(name) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[++index])
  }
  return values
}

function optionValue(name) {
  return optionValues(name).at(-1)
}

function positionals() {
  const out = []
  for (let index = 0; index < args.length; index++) {
    if (args[index].startsWith('--')) {
      if (args[index + 1] && !args[index + 1].startsWith('--')) index++
    } else out.push(args[index])
  }
  return out
}

function parseSelections(values) {
  const selections = {}
  for (const value of values) {
    const separator = value.indexOf('=')
    if (separator < 1 || separator === value.length - 1) throw new Error(`invalid --select value: ${value}; use step-id=package-name`)
    const stepId = value.slice(0, separator)
    const packageName = value.slice(separator + 1)
    if (Object.hasOwn(selections, stepId)) throw new Error(`step selected more than once: ${stepId}`)
    selections[stepId] = packageName
  }
  return selections
}

function help() {
  console.log(`dsh-diy — AI-guided DSH workspace builder (development preview)

Commands:
  recommend <goal>                         Find plugin candidates for a goal
  workspaces                               List bundled workspace recipes
  workspace <id>                           Show a workspace recipe
  plan --workspace <id> --profile <name>   Print an install plan; does not install
       [--select step-id=package-name ...]

Examples:
  dsh-diy recommend "视频剪辑和字幕"
  dsh-diy plan --workspace video-creator --profile video-studio \\
    --select video-project=dsh-remotion --select media-edit=dsh-ffmpeg
`)
}

async function main() {
  const catalog = await loadCatalog()
  if (command === 'help' || command === '--help' || command === '-h') return help()

  if (command === 'recommend') {
    const query = positionals().join(' ').trim()
    if (!query) throw new Error('provide a goal, for example: dsh-diy recommend "视频剪辑和字幕"')
    const result = recommendPlugins(catalog, query)
    console.log(`目标：${result.query}`)
    console.log(`目录日期：${result.catalogAsOf}`)
    if (!result.capabilities.length) {
      console.log('没有找到匹配能力。可以换一种说法，或补充目录能力。')
      return
    }
    console.log(`匹配能力：${result.capabilities.map(item => `${item.name.zh || item.name.en} (${item.id})`).join('、')}`)
    for (const candidate of result.candidates) {
      const title = candidate.summary.zh || candidate.summary.en
      console.log(`\n${candidate.eligible ? '候选' : '暂不可用'}：${candidate.package} v${candidate.versionObserved}`)
      console.log(`  ${title}`)
      console.log(`  覆盖：${candidate.capabilityNames.join('、')}`)
      console.log(`  兼容性：${candidate.compatibility}；证据：${candidate.evidence.level}`)
      console.log(`  说明：${candidate.reasons.join(', ')}`)
      if (candidate.links?.npm) console.log(`  npm：${candidate.links.npm}`)
    }
    if (result.missingCapabilities.length) console.log(`\n目录暂无候选的能力：${result.missingCapabilities.join('、')}`)
    console.log('\n候选能力来自插件目录声明，尚不代表整条工作流已验证。')
    return
  }

  if (command === 'workspaces') {
    for (const workspace of await listWorkspaces()) {
      console.log(`${workspace.id}\t${workspace.name.zh || workspace.name.en}\t${workspace.description.zh || workspace.description.en}`)
    }
    return
  }

  if (command === 'workspace') {
    const id = positionals()[0]
    if (!id) throw new Error('provide a workspace id')
    console.log(JSON.stringify(await loadWorkspace(id, catalog), null, 2))
    return
  }

  if (command === 'plan') {
    const workspaceId = optionValue('--workspace')
    const profile = optionValue('--profile')
    if (!workspaceId || !profile) throw new Error('plan needs --workspace <id> and --profile <name>')
    const recipe = await loadWorkspace(workspaceId, catalog)
    const resolved = await resolveWorkspace(catalog, workspaceId, {selections: parseSelections(optionValues('--select'))})
    const plan = buildApplyPlan(catalog, resolved, {profile})
    console.log(JSON.stringify({catalogAsOf: catalog.metadata.asOf, recipe, resolved, plan}, null, 2))
    return
  }

  help()
  throw new Error(`unknown command: ${command}`)
}

main().catch(error => {
  process.stderr.write(`dsh-diy: ${error.message}\n`)
  process.exitCode = 1
})
