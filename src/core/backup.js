import {createHash, randomUUID} from 'node:crypto'
import {chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {validateTargetProfile} from './schema.js'

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']
const BACKUP_ROOT_NAME = 'dsh-diy/backups'
const BACKUP_ID = /^[A-Za-z0-9-]{20,80}$/

function standaloneRestoreSource(profile, id) {
  return `#!/usr/bin/env node
import {createHash, randomUUID} from 'node:crypto'
import {chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const profile = ${JSON.stringify(profile)}
const id = ${JSON.stringify(id)}
const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']
const capsuleDir = dirname(fileURLToPath(import.meta.url))
const backupRoot = dirname(capsuleDir)
const home = resolve(backupRoot, '../../..')
const profileRoot = await realpath(join(home, 'profiles'))
const profileDir = await realpath(join(profileRoot, profile))
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)) }
if (!inside(profileRoot, profileDir)) throw new Error('profile directory escapes DSH profiles')
const manifestPath = join(capsuleDir, 'manifest.json')
const manifestInfo = await lstat(manifestPath)
if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('capsule manifest is not a regular file')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.format !== 1 || manifest.id !== id || manifest.profile !== profile) throw new Error('capsule does not match this restore command')
for (const [name, info] of Object.entries(manifest.files || {})) {
  if (!files.includes(name) || !info.present) continue
  const source = join(capsuleDir, name)
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('capsule file is not regular: ' + name)
  const hash = createHash('sha256').update(await readFile(source)).digest('hex')
  if (hash !== info.sha256) throw new Error('capsule file hash mismatch: ' + name)
}

// Keep a self-contained capsule of the state being replaced, so this restore is reversible.
const safetyId = 'pre-restore-' + new Date().toISOString().replace(/[^0-9TZ]/g, '-') + '-' + randomUUID()
const safetyDir = join(backupRoot, safetyId)
await mkdir(safetyDir, {recursive: false, mode: 0o700})
const previousFiles = {}
for (const name of files) {
  try {
    const source = join(profileDir, name)
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('profile file is not regular: ' + name)
    const content = await readFile(source)
    await writeFile(join(safetyDir, name), content, {mode: 0o600, flag: 'wx'})
    previousFiles[name] = {present: true, mode: info.mode & 0o777, sha256: createHash('sha256').update(content).digest('hex')}
  } catch (error) {
    if (error.code === 'ENOENT') previousFiles[name] = {present: false}
    else throw error
  }
}
await writeFile(join(safetyDir, 'manifest.json'), JSON.stringify({format: 1, id: safetyId, profile, createdAt: new Date().toISOString(), files: previousFiles}, null, 2), {mode: 0o600, flag: 'wx'})
const ownScript = await readFile(fileURLToPath(import.meta.url), 'utf8')
const safetyScript = ownScript.replace('const id = ' + JSON.stringify(id) + ';', 'const id = ' + JSON.stringify(safetyId) + ';')
await writeFile(join(safetyDir, 'restore.mjs'), safetyScript, {mode: 0o700, flag: 'wx'})

const staging = join(profileDir, '.dsh-diy-restore-' + randomUUID())
await mkdir(staging, {mode: 0o700})
try {
  for (const name of files) if (manifest.files?.[name]?.present) await copyFile(join(capsuleDir, name), join(staging, name))
  for (const name of files) {
    const target = join(profileDir, name)
    const info = manifest.files?.[name]
    if (info?.present) {
      const staged = join(staging, name)
      await chmod(staged, info.mode || 0o600)
      await rename(staged, target)
    } else await rm(target, {force: true})
  }
} finally { await rm(staging, {recursive: true, force: true}) }
console.log('恢复完成：profile 配置文件已还原。')
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
console.log('如需撤销这次恢复，可运行：node ' + shellQuote(join(safetyDir, 'restore.mjs')))
console.log('正在按恢复点中的锁文件重建插件依赖……')
const install = spawnSync('dsh', ['plugin', '--profile', profile, 'install', '--frozen-lockfile'], {stdio: 'inherit'})
if (install.error || install.status !== 0) {
  console.error('依赖重建未完成。请完全退出 DSH 后，在终端运行：dsh plugin --profile ' + profile + ' install --frozen-lockfile')
  if (install.error) console.error(install.error.message)
  process.exitCode = install.status || 1
} else {
  console.log('依赖已按恢复点重建。请完全退出并重新打开 DSH。')
}
`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function resolveDshHome(env = process.env) {
  const configured = String(env.DSH_HOME || '').trim()
  const selected = configured || join(homedir(), '.dsh')
  const expanded = selected === '~' ? homedir()
    : selected.startsWith('~/') || selected.startsWith('~\\') ? join(homedir(), selected.slice(2))
      : selected
  return resolve(expanded)
}

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function resolveProfilePath(profile, env) {
  validateTargetProfile(profile)
  const home = resolveDshHome(env)
  const profilesRoot = await realpath(join(home, 'profiles'))
  const profilePath = await realpath(join(profilesRoot, profile))
  if (!inside(profilesRoot, profilePath)) throw new Error('profile path resolves outside DSH profiles')
  const packagePath = join(profilePath, 'package.json')
  await stat(packagePath)
  return {home, profilesRoot, profilePath}
}

async function resolveBackupRoot(profile, env, {create = false} = {}) {
  validateTargetProfile(profile)
  const home = resolveDshHome(env)
  const base = join(home, BACKUP_ROOT_NAME)
  if (create) await mkdir(base, {recursive: true, mode: 0o700})
  let realBase
  try { realBase = await realpath(base) }
  catch (error) { if (error.code === 'ENOENT' && !create) return {home, root: base, exists: false}; throw error }
  if (!inside(home, realBase)) throw new Error('backup directory resolves outside DSH home')
  const selected = join(realBase, profile)
  if (create) await mkdir(selected, {recursive: true, mode: 0o700})
  let root
  try { root = await realpath(selected) }
  catch (error) { if (error.code === 'ENOENT' && !create) return {home, root: selected, exists: false}; throw error }
  if (!inside(realBase, root)) throw new Error('profile backup directory resolves outside backup root')
  return {home, root, exists: true}
}

function parseProfileManifest(text) {
  try { return JSON.parse(text) } catch { return {} }
}

function manifestState(packageText) {
  const pkg = parseProfileManifest(packageText || '{}')
  return {
    dependencies: pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {},
    bundles: Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [],
  }
}

export async function createProfileBackup(profile, {env = process.env, now = () => new Date()} = {}) {
  const {profilePath} = await resolveProfilePath(profile, env)
  const {root: backupRoot} = await resolveBackupRoot(profile, env, {create: true})
  await chmod(backupRoot, 0o700)
  const createdAt = now().toISOString()
  const timestamp = createdAt.replace(/[^0-9TZ]/g, '-')
  const id = `${timestamp}-${randomUUID()}`
  const staging = join(backupRoot, `.staging-${id}`)
  const destination = join(backupRoot, id)
  await mkdir(staging, {mode: 0o700})

  const files = {}
  let packageText = '{}'
  try {
    for (const name of PROFILE_FILES) {
      const source = join(profilePath, name)
      try {
        const info = await lstat(source)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} is not a regular file`)
        const content = await readFile(source)
        if (name === 'package.json') packageText = content.toString('utf8')
        const target = join(staging, name)
        await writeFile(target, content, {mode: 0o600, flag: 'wx'})
        files[name] = {
          present: true,
          size: content.byteLength,
          mode: info.mode & 0o777,
          sha256: createHash('sha256').update(content).digest('hex'),
        }
      } catch (error) {
        if (error.code === 'ENOENT') files[name] = {present: false}
        else throw error
      }
    }

    const manifest = {
      format: 1,
      id,
      profile,
      createdAt,
      files,
      state: manifestState(packageText),
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), {mode: 0o600, flag: 'wx'})
    await writeFile(join(staging, 'restore.mjs'), standaloneRestoreSource(profile, id), {mode: 0o700, flag: 'wx'})
    await rename(staging, destination)
    const restoreScript = join(destination, 'restore.mjs')
    return {id, profile, createdAt: manifest.createdAt, files: Object.keys(files).filter(name => files[name].present), capsulePath: destination, restoreCommand: `node ${shellQuote(restoreScript)}`}
  } catch (error) {
    await rm(staging, {recursive: true, force: true}).catch(() => {})
    throw error
  }
}

export async function listProfileBackups(profile, {env = process.env} = {}) {
  const {root: backupRoot, exists} = await resolveBackupRoot(profile, env)
  if (!exists) return []
  let names
  try { names = await readdir(backupRoot, {withFileTypes: true}) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const rows = []
  for (const entry of names) {
    if (!entry.isDirectory() || !BACKUP_ID.test(entry.name)) continue
    try {
      const capsuleDir = join(backupRoot, entry.name)
      const manifestPath = join(capsuleDir, 'manifest.json')
      const manifestInfo = await lstat(manifestPath)
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) continue
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.format !== 1 || manifest.id !== entry.name || manifest.profile !== profile) continue
      const restoreScript = join(capsuleDir, 'restore.mjs')
      let restoreCommand = null
      try {
        const restoreInfo = await lstat(restoreScript)
        if (restoreInfo.isFile() && !restoreInfo.isSymbolicLink()) restoreCommand = `node ${shellQuote(restoreScript)}`
      } catch { /* Older capsules can still be restored from the DSH DIY panel. */ }
      rows.push({id: manifest.id, profile, createdAt: manifest.createdAt, files: Object.keys(manifest.files || {}).filter(name => manifest.files[name]?.present), capsulePath: capsuleDir, restoreCommand})
    } catch { /* Incomplete or unreadable snapshots are not offered for restore. */ }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readProfileBackup(profile, id, {env = process.env} = {}) {
  validateTargetProfile(profile)
  if (typeof id !== 'string' || !BACKUP_ID.test(id)) throw new Error('invalid backup id')
  const {root} = await resolveBackupRoot(profile, env)
  const dir = await realpath(join(root, id))
  if (!inside(root, dir)) throw new Error('backup snapshot resolves outside backup root')
  const manifestPath = join(dir, 'manifest.json')
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('backup manifest is not a regular file')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.format !== 1 || manifest.id !== id || manifest.profile !== profile) throw new Error('backup does not match this profile')
  for (const [name, info] of Object.entries(manifest.files || {})) {
    if (!PROFILE_FILES.includes(name) || !info?.present) continue
    const file = join(dir, name)
    const infoOnDisk = await lstat(file)
    if (!infoOnDisk.isFile() || infoOnDisk.isSymbolicLink()) throw new Error(`backup file is not regular: ${name}`)
    const content = await readFile(file)
    const hash = createHash('sha256').update(content).digest('hex')
    if (hash !== info.sha256) throw new Error(`backup file hash mismatch: ${name}`)
  }
  return {dir, manifest}
}

export async function restoreProfileFiles(profile, id, {env = process.env} = {}) {
  const {profilePath} = await resolveProfilePath(profile, env)
  const {dir, manifest} = await readProfileBackup(profile, id, {env})
  const staging = join(profilePath, `.dsh-diy-restore-${randomUUID()}`)
  await mkdir(staging, {mode: 0o700})
  try {
    for (const name of PROFILE_FILES) {
      const info = manifest.files?.[name]
      if (info?.present) await copyFile(join(dir, name), join(staging, name))
    }
    for (const name of PROFILE_FILES) {
      const target = join(profilePath, name)
      const info = manifest.files?.[name]
      if (info?.present) {
        const staged = join(staging, name)
        await chmod(staged, info.mode || 0o600)
        await rename(staged, target)
      } else {
        await rm(target, {force: true})
      }
    }
  } finally {
    await rm(staging, {recursive: true, force: true})
  }
  return {
    profile,
    backupId: id,
    createdAt: manifest.createdAt,
    state: manifest.state,
    recoveryCommand: `dsh plugin --profile ${profile} install --frozen-lockfile`,
    restartRequired: true,
  }
}
