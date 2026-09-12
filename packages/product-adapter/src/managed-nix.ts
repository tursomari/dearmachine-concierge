import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { migrateProfile } from './profile-migration.ts'

const exec = promisify(execFile)
const components = ['dearmachine', 'machtiani-harness', 'machtiani-installer'] as const
const commands = ['dearmachine', 'agent-manager', 'machtiani', 'machtiani-installer', 'machtiani-model-host'] as const
const revisionPattern = /^[a-f0-9]{40}$/u
export interface ManagedRelease {
  version: 1
  method: 'nix'
  remote: string
  branch: string
  revision: string
  revisions: Record<string, string>
  sourceRoot: string
  binaries: Record<string, string>
}
export type ManagedRun = (command: string, args: string[], cwd?: string) => Promise<string>
export interface ManagedOptions {
  home: string
  dataHome?: string
  run?: ManagedRun
  progress?: (text: string) => void
}

export class UnsupportedManagedInstallationError extends Error {
  constructor() {
    super('This installation is not managed by the coordinated Nix installer. Existing installations and Standard releases are not migrated automatically.')
    this.name = 'UnsupportedManagedInstallationError'
  }
}

export class ManagedNix {
  readonly root: string
  readonly run: ManagedRun
  constructor(readonly options: ManagedOptions) {
    if (!isAbsolute(options.home) || (options.dataHome !== undefined && !isAbsolute(options.dataHome))) throw new Error('HOME and XDG_DATA_HOME must be absolute')
    this.root = join(options.dataHome ?? join(options.home, '.local/share'), 'dearmachine')
    this.run = options.run ?? (async (command, args, cwd) => {
      try {
        const result = await exec(command, args, { ...(cwd === undefined ? {} : { cwd }), maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, HOME: options.home, GIT_TERMINAL_PROMPT: '0' } })
        return result.stdout
      } catch { throw new Error(`${command.split('/').at(-1)} failed during managed installation; activation was not confirmed`) }
    })
  }
  private referencePath(): string { return join(this.options.home, '.config/dearmachine/source-reference.json') }
  private current(): string { return join(this.root, 'current') }
  private async receipt(): Promise<ManagedRelease> {
    if (await exists(join(this.root, 'transaction.json'))) throw new Error('An interrupted update needs recovery: run dearmachine update --recover')
    const path = join(this.current(), 'release.json')
    if (!await exists(path)) throw new UnsupportedManagedInstallationError()
    const receipt = await privateJSON(path) as ManagedRelease
    this.validateRelease(receipt)
    if (await readlink(this.current()) !== join(this.root, 'releases', receipt.revision)) throw new Error('Active release link differs from its receipt')
    return receipt
  }
  private validateRelease(receipt: ManagedRelease): void {
    if (!receipt || receipt.version !== 1 || receipt.method !== 'nix' || !revisionPattern.test(receipt.revision) ||
      typeof receipt.branch !== 'string' || !receipt.revisions || receipt.revisions['.'] !== receipt.revision ||
      receipt.sourceRoot !== join(this.root, 'sources', receipt.revision) || !receipt.binaries) throw new Error('Invalid managed release receipt')
    validateRemote(receipt.remote)
    for (const name of commands) if (!new RegExp(`^/nix/store/[a-z0-9]{32}-[^\\s/]+/bin/${name}$`, 'u').test(receipt.binaries[name] ?? '')) throw new Error('Invalid managed executable path')
    for (const component of components) if (!revisionPattern.test(receipt.revisions[component] ?? '')) throw new Error('Missing component revision')
  }
  async check(): Promise<{ current: string; available: string; status: 'current' | 'available' }> {
    const receipt = await this.receipt()
    const available = await this.remoteHead(receipt.remote)
    return { current: receipt.revision, available: available.revision, status: receipt.revision === available.revision ? 'current' : 'available' }
  }
  private async remoteHead(remote: string): Promise<{ revision: string; branch: string }> {
    validateRemote(remote)
    const result = await this.run('git', ['ls-remote', '--symref', remote, 'HEAD'])
    const branch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(result)?.[1]
    const revision = /^([a-f0-9]{40})\s+HEAD$/mu.exec(result)?.[1]
    if (!branch || !revision) throw new Error('Cannot resolve the release source default branch')
    return { branch, revision }
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await safeDirectory(this.root)
    const lock = join(this.root, 'update.lock')
    await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Another update may be running; inspect the managed update lock before retrying') })
    try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 }); return await work() }
    finally { await rm(lock, { recursive: true }) }
  }
  async install(source: string): Promise<ManagedRelease> {
    return this.locked(async () => {
      source = await realpath(source)
      if (await exists(this.current())) {
        const existing = await this.receipt()
        await this.checkLaunchers(true)
        if (existing.sourceRoot === source) return existing
      }
      const remote = (await this.run('git', ['-C', source, 'remote', 'get-url', 'origin'])).trim()
      validateRemote(remote)
      const revision = (await this.run('git', ['-C', source, 'rev-parse', 'HEAD'])).trim()
      if (await exists(this.current())) {
        const existing = await this.receipt()
        await this.checkLaunchers(true)
        if (existing.revision === revision && existing.remote === remote) return existing
        if (existing.remote !== remote) throw new Error('The checkout belongs to a different release source; the managed installation was left unchanged')
        const release = await this.prepare(source, revision, remote, existing.branch)
        await this.activate(release, existing)
        return release
      }
      await this.checkLaunchers(false)
      const branch = (await this.remoteHead(remote)).branch
      const release = await this.prepare(source, revision, remote, branch)
      await this.activate(release, undefined)
      return release
    })
  }
  async update(): Promise<ManagedRelease> {
    return this.locked(async () => {
      const previous = await this.receipt()
      await this.checkLaunchers(true)
      const latest = await this.remoteHead(previous.remote)
      if (latest.revision === previous.revision) return previous
      const stage = await mkdtemp(join(this.root, '.fetch-'))
      try {
        const checkout = join(stage, 'checkout')
        this.options.progress?.('Fetching the coordinated release')
        await this.run('git', ['clone', '--no-checkout', '--', previous.remote, checkout])
        await this.run('git', ['-C', checkout, 'checkout', '--detach', latest.revision])
        await this.run('git', ['-C', checkout, 'submodule', 'update', '--init', '--recursive'])
        const release = await this.prepare(checkout, latest.revision, previous.remote, latest.branch)
        await this.activate(release, previous)
        return release
      } finally { await rm(stage, { recursive: true, force: true }) }
    })
  }
  private async prepare(checkout: string, revision: string, remote: string, branch: string): Promise<ManagedRelease> {
    if (!revisionPattern.test(revision)) throw new Error('Invalid umbrella revision')
    await safeDirectory(join(this.root, 'sources'))
    await safeDirectory(join(this.root, 'releases'))
    const stage = await mkdtemp(join(this.root, '.prepare-'))
    try {
      const source = join(stage, 'source')
      await mkdir(source)
      const revisions: Record<string, string> = { '.': revision }
      await this.archive(checkout, revision, source, '.', revisions)
      for (const component of components) if (!revisions[component]) throw new Error(`Missing pinned component: ${component}`)
      const documentation = await lstat(join(source, 'docs/README.md'))
      if (!documentation.isFile() || documentation.isSymbolicLink()) throw new Error('Release documentation entry point is missing or unsafe')
      await writeFile(join(source, 'bootstrap-source-revisions.json'), JSON.stringify(revisions, null, 2) + '\n')
      const snapshot = join(this.root, 'sources', revision)
      if (await exists(snapshot)) {
        if (await digestTree(snapshot) !== await digestTree(source)) throw new Error('Existing source snapshot differs from its recorded revision')
      } else await rename(source, snapshot)
      this.options.progress?.('Building the client, Machtiani, and concierge at their pinned revisions')
      const binaries: Record<string, string> = {}
      const releaseDir = join(this.root, 'releases', revision)
      if (await exists(releaseDir)) {
        const saved = await privateJSON(join(releaseDir, 'release.json')) as ManagedRelease
        this.validateRelease(saved)
        if (saved.revision !== revision || saved.remote !== remote || saved.sourceRoot !== snapshot || JSON.stringify(saved.revisions) !== JSON.stringify(revisions)) throw new Error('Existing prepared release metadata differs')
        for (const name of commands) {
          if (!/^\/nix\/store\/[a-z0-9]{32}-[^\s/]+\/bin\/[^/]+$/u.test(saved.binaries[name] ?? '')) throw new Error('Invalid prepared executable')
          await this.run(saved.binaries[name]!, [name === 'machtiani' ? '--version' : '--help'])
        }
        await this.run(saved.binaries.dearmachine!, ['update', '--help'])
        await this.run(saved.binaries['machtiani-installer']!, ['update', '--help'])
        for (const component of components) await this.run('nix-store', ['--add-root', join(releaseDir, 'roots', component), '--indirect', '--realise', await readlink(join(releaseDir, 'roots', component))])
        return saved
      }
      const prepared = join(stage, 'release')
      await mkdir(prepared)
      await mkdir(join(prepared, 'roots'))
      for (const component of components) {
        const output = (await this.run('nix', ['build', '--out-link', join(prepared, 'roots', component), '--print-out-paths', `path:${join(snapshot, component)}`])).trim()
        if (!/^\/nix\/store\/[a-z0-9]{32}-[^\s/]+$/u.test(output)) throw new Error('Nix returned an invalid package path')
        // Durable roots move with the completed release; registration happens after the rename.
        const names = component === 'dearmachine' ? ['dearmachine', 'agent-manager'] : component === 'machtiani-harness' ? ['machtiani'] : ['machtiani-installer', 'machtiani-model-host']
        for (const name of names) binaries[name] = join(output, 'bin', name)
      }
      const release: ManagedRelease = { version: 1, method: 'nix', revision, remote, branch, revisions, sourceRoot: snapshot, binaries }
      await mkdir(join(prepared, 'bin'))
      for (const name of commands) {
        await this.run(binaries[name]!, [name === 'machtiani' ? '--version' : '--help'])
        const binary = binaries[name]!
        // Keep model-host references and launch paths stable across atomic current switches.
        let prefix = `export DEARMACHINE_MANAGED_DATA_HOME=${quote(dirname(this.root))}\nexport PATH=${quote(join(this.current(), 'bin'))}:"$PATH"\n`
        if (name === 'dearmachine') prefix += `export DEARMACHINE_CONCIERGE_BIN=${quote(binaries['machtiani-installer']!)}\nexport DEARMACHINE_SOURCE_ROOT=${quote(snapshot)}\n`
        if (name === 'machtiani') prefix += `export MACHTIANI_UPDATE_REEXEC=1\nif [ "\${1:-}" = update ]; then shift; exec ${quote(join(this.current(), 'bin/dearmachine'))} update "$@"; fi\n`
        await writeFile(join(prepared, 'bin', name), `#!/bin/sh\n${prefix}exec ${quote(binary)} "$@"\n`, { mode: 0o755 })
      }
      await this.run(binaries.dearmachine!, ['update', '--help'])
      await this.run(binaries['machtiani-installer']!, ['update', '--help'])
      await writeFile(join(prepared, 'release.json'), JSON.stringify(release, null, 2) + '\n', { mode: 0o600 })
      await rename(prepared, releaseDir)
      for (const component of components) await this.run('nix-store', ['--add-root', join(releaseDir, 'roots', component), '--indirect', '--realise', await readlink(join(releaseDir, 'roots', component))])
      return release
    } finally { await rm(stage, { recursive: true, force: true }) }
  }
  private async archive(checkout: string, revision: string, destination: string, prefix: string, revisions: Record<string, string>): Promise<void> {
    const tree = await this.run('git', ['-C', checkout, 'ls-tree', '-rz', revision])
    const children: Array<{ path: string; revision: string }> = []
    for (const entry of tree.split('\0').filter(Boolean)) {
      const parsed = /^(\d+) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry)
      if (!parsed) throw new Error('Invalid source tree entry')
      const [, mode, type, oid, path] = parsed as unknown as [string, string, string, string, string]
      if (path.split('/').some(part => part === '.env' || part.startsWith('.env.'))) continue
      if (!safeMember(path)) throw new Error('Unsafe or credential-like tracked source path; refuse to publish this snapshot')
      if (type === 'commit') { children.push({ path, revision: oid }); continue }
      if (mode === '120000') {
        const target = (await this.run('git', ['-C', checkout, 'cat-file', 'blob', oid])).trim()
        const resolved = resolve(destination, dirname(path), target)
        if (isAbsolute(target) || relative(destination, resolved).startsWith('..')) throw new Error('Source symlink escapes the snapshot')
      }
    }
    await mkdir(destination, { recursive: true })
    const archive = join(dirname(destination), `.archive-${randomUUID()}.tar`)
    try {
      await this.run('git', ['-C', checkout, 'archive', '--format=tar', `--output=${archive}`, revision])
      await this.run('tar', ['-xf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions', '--exclude=.env', '--exclude=.env.*'])
    } finally { await rm(archive, { force: true }) }
    for (const child of children) {
      const key = prefix === '.' ? child.path : `${prefix}/${child.path}`
      revisions[key] = child.revision
      await this.archive(join(checkout, child.path), child.revision, join(destination, child.path), key, revisions)
    }
  }
  private standaloneMachtiani(): string { return join(this.options.home, '.machtiani/installations/machtiani/profile/bin/machtiani') }
  private async checkLaunchers(managed: boolean): Promise<void> {
    const bin = join(this.options.home, '.local/bin')
    for (const name of commands) {
      const path = join(bin, name)
      if (!await exists(path)) { if (managed) throw new Error(`Managed launcher is missing: ${name}`); continue }
      if (!managed && name === 'machtiani' && await readlink(path).catch(() => '') === this.standaloneMachtiani()) continue
      if (!managed || await readlink(path).catch(() => '') !== join(this.current(), 'bin', name)) throw new Error(`Existing ${name} is not owned by this installation; automatic replacement is disabled`)
    }
  }
  private async activate(release: ManagedRelease, previous: ManagedRelease | undefined): Promise<void> {
    await this.checkLaunchers(previous !== undefined)
    const reference = this.referencePath()
    if (await exists(reference)) {
      const metadata = await lstat(reference)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error('Source reference must be a private owned regular file')
    }
    const oldReference = await readFile(reference, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    const runtime = previous ? JSON.parse(await this.run(previous.binaries.dearmachine!, ['_update-control', 'status'])) as { running: boolean } : { running: false }
    if (typeof runtime.running !== 'boolean') throw new Error('Cannot determine client state before updating')
    const standaloneMachtiani = !previous && await readlink(join(this.options.home, '.local/bin/machtiani')).catch(() => '') === this.standaloneMachtiani()
    const transaction = { previous: previous ?? null, next: release, oldReference, running: runtime.running, standaloneMachtiani }
    await atomicJSON(join(this.root, 'transaction.json'), transaction)
    try {
      if (previous) await this.run(previous.binaries.dearmachine!, ['_update-control', 'stop'])
      await this.switchCurrent(release)
      await safeDirectory(join(this.options.home, '.local/bin'))
      if (!previous) for (const name of commands) {
        const path = join(this.options.home, '.local/bin', name)
        if (name === 'machtiani' && standaloneMachtiani) {
          if (await readlink(path) !== this.standaloneMachtiani()) throw new Error('Machtiani launcher changed during installation')
          const temporary = join(this.options.home, '.local/bin', `.machtiani-${randomUUID()}`)
          try { await symlink(join(this.current(), 'bin', name), temporary); await rename(temporary, path) }
          finally { await rm(temporary, { force: true }) }
        } else await symlink(join(this.current(), 'bin', name), path)
      }
      await atomicJSON(reference, sourceReference(release))
      if (previous) await this.run(release.binaries.dearmachine!, ['_update-control', 'refresh'])
      if (runtime.running) await this.run(release.binaries.dearmachine!, ['up'])
      await rm(join(this.root, 'transaction.json'))
    } catch (error) {
      await this.rollback(transaction)
      throw error
    }
  }
  private async switchCurrent(release: ManagedRelease): Promise<void> {
    const temporary = join(this.root, `.current-${randomUUID()}`)
    await symlink(join(this.root, 'releases', release.revision), temporary)
    await rename(temporary, this.current())
  }
  private async rollback(transaction: { previous: ManagedRelease | null; next: ManagedRelease; oldReference: string | null; running: boolean; standaloneMachtiani?: boolean }): Promise<void> {
    // The journal is retained if any recovery step fails; never announce success in that case.
    await this.run(transaction.next.binaries.dearmachine!, ['_update-control', 'stop'])
    if (transaction.previous) await this.switchCurrent(transaction.previous)
    else {
      for (const name of commands) {
        const path = join(this.options.home, '.local/bin', name)
        if (await readlink(path).catch(() => '') === join(this.current(), 'bin', name)) await rm(path)
      }
      if (transaction.standaloneMachtiani && !await exists(join(this.options.home, '.local/bin/machtiani'))) await symlink(this.standaloneMachtiani(), join(this.options.home, '.local/bin/machtiani'))
      await rm(this.current(), { force: true })
    }
    if (transaction.oldReference === null) await rm(this.referencePath(), { force: true })
    else await atomicText(this.referencePath(), transaction.oldReference)
    if (transaction.previous) {
      await this.run(transaction.previous.binaries.dearmachine!, ['_update-control', 'refresh'])
      if (transaction.running) await this.run(transaction.previous.binaries.dearmachine!, ['up'])
    }
    await rm(join(this.root, 'transaction.json'))
  }
  async migrateProfile(entry: string, check = false) {
    const work = async () => {
      await this.receipt()
      await this.checkLaunchers(true)
      return migrateProfile({ home: this.options.home, root: this.root, entry, check, run: this.run })
    }
    return check ? work() : this.locked(work)
  }
  async recover(): Promise<void> {
    await this.locked(async () => {
      const path = join(this.root, 'transaction.json')
      const transaction = await privateJSON(path) as Parameters<ManagedNix['rollback']>[0]
      if (!transaction || typeof transaction.running !== 'boolean' || (transaction.oldReference !== null && typeof transaction.oldReference !== 'string')) throw new Error('Invalid update recovery journal')
      if (transaction.standaloneMachtiani !== undefined && typeof transaction.standaloneMachtiani !== 'boolean') throw new Error('Invalid standalone launcher recovery state')
      this.validateRelease(transaction.next)
      if (transaction.previous !== null) this.validateRelease(transaction.previous)
      else if (transaction.running) throw new Error('Invalid initial installation recovery state')
      await this.rollback(transaction)
    })
  }
}
function sourceReference(release: ManagedRelease) {
  return { version: 1, sourceRoot: release.sourceRoot, documentationEntryPoint: join(release.sourceRoot, 'docs/README.md'), umbrellaRevision: release.revision }
}
function validateRemote(remote: string): void {
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(remote)) return
  let url: URL
  try { url = new URL(remote) } catch { throw new Error('Release source must be an HTTPS or SSH Git remote') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Release source must be an HTTPS remote without embedded credentials, or an SSH Git remote')
}
function safeMember(path: string): boolean {
  return path !== '' && !isAbsolute(path) && path.split('/').every(part => part !== '..' && !['.git', '.ssh', '.secrets', '.env'].includes(part) && !part.startsWith('.env.') && !part.includes('\n'))
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function safeDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Expected an absolute installation directory')
  if (path !== dirname(path)) await safeDirectory(dirname(path))
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== process.getuid?.() && info.uid !== 0) || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) throw new Error(`Unsafe installation directory: ${path}`)
}
async function atomicText(path: string, value: string): Promise<void> {
  await safeDirectory(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
async function atomicJSON(path: string, value: unknown): Promise<void> { await atomicText(path, JSON.stringify(value, null, 2) + '\n') }
async function digestTree(path: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(root: string): Promise<void> {
    for (const name of (await readdir(root)).sort()) {
      const item = join(root, name)
      const info = await lstat(item)
      hash.update(relative(path, item) + '\0' + info.mode.toString() + '\0')
      if (info.isDirectory()) await visit(item)
      else if (info.isSymbolicLink()) hash.update(await readlink(item))
      else if (info.isFile()) hash.update(await readFile(item))
      else throw new Error('Unexpected source snapshot file type')
    }
  }
  await visit(path)
  return hash.digest('hex')
}

async function privateJSON(path: string): Promise<unknown> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 131072) throw new Error('Managed metadata must be a small private regular file owned by the current user')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
