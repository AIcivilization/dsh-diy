#!/usr/bin/env node
// Import the public dsh-pick ecosystem snapshot as a discovery index.
// Usage: node scripts/build-plugin-directory.mjs <dsh-pick-data/catalog.json> [output.json]
import {readFile, writeFile} from 'node:fs/promises'
import semver from 'semver'
import {fileURLToPath} from 'node:url'

const [input, output = fileURLToPath(new URL('../catalog/plugin-directory.json', import.meta.url))] = process.argv.slice(2)
if (!input) {
  console.error('Usage: node scripts/build-plugin-directory.mjs <dsh-pick-data/catalog.json> [output.json]')
  process.exit(2)
}

const source = JSON.parse(await readFile(input, 'utf8'))
const records = Object.values(source.packages ?? {})
  // The broad npm index also contains non-DSH packages. Keep entries that
  // declare a DSH bundle so users can discover installable DSH components.
  .filter(record => record.inst?.b === true && typeof record.n === 'string')
  .map(record => ({
    package: record.n,
    ...(semver.valid(record.v) ? {versionObserved: record.v} : {}),
    description: record.d?.trim() || record.n,
    category: record.cat?.trim() || '其他',
    keywords: [...new Set((record.kw ?? []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))],
    install: {
      bundle: true,
      ...(record.inst.p ? {clientPlatform: record.inst.p} : {}),
      ...(record.inst.r ? {dshRange: record.inst.r} : {}),
    },
    links: {...(record.repo ? {repository: record.repo} : {}), npm: `https://www.npmjs.com/package/${record.n}`},
    popularity: {
      ...(Number.isFinite(record.w) ? {weeklyDownloads: record.w} : {}),
      ...(Number.isFinite(record.gh?.s) ? {githubStars: record.gh.s} : {}),
      ...(Number.isFinite(record.sc) ? {directoryScore: record.sc} : {}),
    },
    evidence: {
      source: 'dsh-pick aggregated public catalog',
      sourceAsOf: source.asOf ?? 'unknown',
      workflowVerified: false,
    },
  }))
  .sort((a, b) => a.package.localeCompare(b.package))

const unique = new Set()
for (const plugin of records) {
  if (unique.has(plugin.package)) throw new Error(`duplicate package in source catalog: ${plugin.package}`)
  unique.add(plugin.package)
}

const result = {
  schemaVersion: 1,
  metadata: {
    source: 'dsh-pick aggregated public catalog',
    sourceAsOf: source.asOf ?? 'unknown',
    count: records.length,
    selection: 'Entries declaring dsh.bundle=true in the source snapshot.',
    evidencePolicy: 'Discovery metadata only. Inclusion, ranking, downloads, and GitHub stars do not establish quality, safety, compatibility, capability coverage, or workflow interoperability.',
  },
  plugins: records,
}
await writeFile(output, `${JSON.stringify(result)}\n`)
console.log(`Wrote ${records.length} DSH bundle records to ${output}`)
