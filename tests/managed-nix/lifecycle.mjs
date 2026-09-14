// Runs only in the disposable test container. Git/Nix boundaries are fixtures;
// archive extraction, snapshots, launchers, activation and rollback are real.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { ManagedNix } from '../../packages/product-adapter/dist/managed-nix.mjs'

if (process.env.MANAGED_NIX_CONTAINER !== '1') throw new Error('Run with tests/managed-nix/run.sh; this test writes fixture store paths inside a container')
const exec = promisify(execFile)
const old = 'a'.repeat(40), next = 'b'.repeat(40)
const names = ['dearmachine', 'machtiani-harness', 'machtiani-installer']
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'managed-'))
  const home = join(root, 'home')
  await mkdir(home)
  const original = join(root, 'original')
  await mkdir(original)
  const calls = []
  const control = { latest: old, running: false, starts: 0, stops: 0, failBuild: false, failStart: false, failRollback: false, failRefresh: false }
  const archives = new Map()
  for (const revision of [old, next]) {
    for (const part of ['.', ...names, 'machtiani-harness/nested']) {
      const source = join(root, 'archives', revision, part === '.' ? 'umbrella' : part)
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'tracked.txt'), `${revision}:${part}\n`)
      if (part === '.') {
        await mkdir(join(source, 'docs'))
        await writeFile(join(source, 'docs/README.md'), `Release documentation ${revision}\n`)
        await writeFile(join(source, '.env'), 'fixture-private-content')
      }
      const tar = source + '.tar'
      await exec('tar', ['-cf', tar, '-C', source, '.'])
      archives.set(`${revision}:${part}`, tar)
    }
  }
  function partFor(checkout) {
    for (const part of ['machtiani-harness/nested', ...names]) if (checkout.endsWith('/' + part)) return part
    return '.'
  }
  const binaries = {}
  for (const revision of [old, next]) for (const [index, component] of names.entries()) {
    const store = `/nix/store/${revision.slice(0, 31)}${index}-managed-test`
    await mkdir(join(store, 'bin'), { recursive: true })
    binaries[`${revision}:${component}`] = store
    const commands = component === 'dearmachine' ? ['dearmachine', 'agent-manager'] : component === 'machtiani-harness' ? ['machtiani'] : ['machtiani-installer', 'machtiani-model-host']
    for (const name of commands) await writeFile(join(store, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  const run = async (command, args) => {
    calls.push([command, ...args])
    if (command === 'git') {
      if (args[0] === 'ls-remote') return `ref: refs/heads/main\tHEAD\n${control.latest}\tHEAD\n`
      if (args[0] === 'clone') { await mkdir(args.at(-1)); return '' }
      const checkout = args[1], action = args[2]
      if (action === 'remote') return 'https://example.invalid/dearmachine.git\n'
      if (action === 'rev-parse') return old + '\n'
      if (action === 'checkout' || action === 'submodule') return ''
      const revision = args.at(-1)
      const part = partFor(checkout)
      if (action === 'ls-tree') {
        let tree = `100644 blob ${old}\ttracked.txt\0`
        if (part === '.') {
          tree += `100644 blob ${old}\tdocs/README.md\0` + `100644 blob ${old}\t.env\0`
          for (const name of names) tree += `160000 commit ${revision}\t${name}\0`
        }
        if (part === 'machtiani-harness') tree += `160000 commit ${revision}\tnested\0`
        return tree
      }
      if (action === 'archive') {
        await exec('cp', [archives.get(`${revision}:${part}`), args.find(value => value.startsWith('--output=')).slice(9)])
        return ''
      }
      throw new Error('Unexpected Git fixture call')
    }
    if (command === 'nix') {
      if (control.failBuild) throw new Error('fixture build failure')
      const component = names.find(name => args.at(-1).endsWith('/' + name))
      const revision = args.at(-1).includes('/' + next + '/') ? next : old
      const output = binaries[`${revision}:${component}`]
      await symlink(output, args[args.indexOf('--out-link') + 1])
      return output + '\n'
    }
    if (command === 'nix-store') return ''
    if (command.endsWith('/bin/dearmachine')) {
      if (args[0] === '_update-control') {
        if (args[1] === 'status') return JSON.stringify({ running: control.running })
        if (args[1] === 'stop') {
          if (control.failRollback && command.includes(next.slice(0, 31))) throw new Error('fixture rollback interruption')
          control.running = false; control.stops++; return ''
        }
        if (args[1] === 'refresh') {
          if (control.failRefresh && command.includes(next.slice(0, 31))) throw new Error('fixture refresh failure')
          return ''
        }
      }
      if (args[0] === 'up') {
        control.starts++
        if (control.failStart && command.includes(next.slice(0, 31))) throw new Error('fixture startup failure')
        control.running = true
      }
      return ''
    }
    if (command.startsWith('/nix/store/')) return ''
    return (await exec(command, args)).stdout
  }
  const dataHome = options.xdg ? join(root, 'custom-data') : undefined
  const manager = new ManagedNix({ home, ...(dataHome ? { dataHome } : {}), run })
  const reference = join(home, '.config/dearmachine/source-reference.json')
  return { root, home, original, manager, calls, control, reference, async cleanup() { await rm(root, { recursive: true, force: true }) } }
}

for (const xdg of [false, true]) test(`fresh home, snapshot and check-only (XDG=${xdg})`, async t => {
  const f = await fixture({ xdg }); t.after(() => f.cleanup())
  await assert.rejects(readFile(join(f.home, '.local')))
  const installed = await f.manager.install(f.original)
  assert.equal(installed.revision, old)
  assert.equal(await readlink(join(f.manager.root, 'current')), join(f.manager.root, 'releases', old))
  assert.equal(await readFile(join(installed.sourceRoot, 'machtiani-harness/nested/tracked.txt'), 'utf8'), `${old}:machtiani-harness/nested\n`)
  await assert.rejects(readFile(join(installed.sourceRoot, '.env')))
  await assert.rejects(readFile(join(installed.sourceRoot, '.git')))
  await rename(f.original, f.original + '-moved')
  const reference = JSON.parse(await readFile(f.reference))
  assert.equal(reference.sourceRoot, installed.sourceRoot)
  assert.match(await readFile(reference.documentationEntryPoint, 'utf8'), /Release documentation/)
  const before = await readFile(f.reference)
  f.control.latest = next
  const at = f.calls.length
  assert.equal((await f.manager.check()).status, 'available')
  assert.deepEqual(f.calls.slice(at).map(call => call.slice(0, 3)), [['git', 'ls-remote', '--symref']])
  assert.deepEqual(await readFile(f.reference), before)
  assert.equal(f.control.starts, 0)
})

test('update switches coordinated binaries and source, preserves configuration, and leaves a stopped client stopped', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  const sentinels = ['.dearmachine/pairs.toml', '.dearmachine/config/runtime.toml', '.machtiani/config.toml', '.config/machtiani/config.toml', '.config/machtiani/credentials.env', '.config/dearmachine/machtiani/config.toml', '.config/dearmachine/machtiani/credentials.env', '.config/dearmachine/backends.env', '.config/dearmachine/assistant-model.json']
  for (const path of sentinels) { await mkdir(dirname(join(f.home, path)), { recursive: true }); await writeFile(join(f.home, path), 'fixture-preserved-' + path) }
  f.control.latest = next
  await f.manager.update()
  for (const path of sentinels) assert.equal(await readFile(join(f.home, path), 'utf8'), 'fixture-preserved-' + path)
  const reference = JSON.parse(await readFile(f.reference))
  assert.equal(reference.umbrellaRevision, next)
  assert.match(await readFile(reference.documentationEntryPoint, 'utf8'), new RegExp(next))
  assert.equal(f.control.starts, 0)
  assert.equal((await readdir(join(f.manager.root, 'releases'))).length, 2)
  const current = JSON.parse(await readFile(join(f.manager.root, 'current/release.json')))
  assert.equal(Object.keys(current.binaries).length, 5)
  assert.match(await readFile(join(f.home, '.local/bin/machtiani'), 'utf8'), /dearmachine.*update/)
  const calls = f.calls.length
  assert.equal((await f.manager.update()).revision, next)
  assert.equal(f.calls.length, calls + 1)
})

test('running client is restarted and failed startup rolls binaries and source back', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  const reference = await readFile(f.reference)
  f.control.latest = next; f.control.running = true; f.control.failStart = true
  await assert.rejects(f.manager.update(), /startup failure/)
  assert.equal(f.control.running, true)
  assert.deepEqual(await readFile(f.reference), reference)
  assert.equal(await readlink(join(f.manager.root, 'current')), join(f.manager.root, 'releases', old))
  f.control.failStart = false
  await f.manager.update()
  assert.equal(f.control.running, true)
  assert.equal(JSON.parse(await readFile(f.reference)).umbrellaRevision, next)
})

test('failed build does not interrupt the client or activate a source reference', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  const reference = await readFile(f.reference)
  f.control.latest = next; f.control.running = true; f.control.failBuild = true
  await assert.rejects(f.manager.update(), /build failure/)
  assert.deepEqual(await readFile(f.reference), reference)
  assert.equal(f.control.stops, 0)
  assert.equal(f.control.running, true)
})

test('interrupted rollback retains its journal and explicit recovery restores the previous release', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  f.control.latest = next; f.control.running = true; f.control.failStart = true; f.control.failRollback = true
  await assert.rejects(f.manager.update(), /rollback interruption/)
  await assert.rejects(f.manager.check(), /recover/)
  assert.ok(await readFile(join(f.manager.root, 'transaction.json')))
  f.control.failRollback = false
  await f.manager.recover()
  assert.equal(JSON.parse(await readFile(f.reference)).umbrellaRevision, old)
  assert.equal(f.control.running, true)
  await assert.rejects(readFile(join(f.manager.root, 'transaction.json')))
})

test('unmanaged commands and substituted directories are preserved', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await mkdir(join(f.home, '.local/bin'), { recursive: true })
  const existing = join(f.home, '.local/bin/machtiani')
  await writeFile(existing, 'existing-user-launcher')
  await assert.rejects(f.manager.install(f.original), /not owned/)
  assert.equal(await readFile(existing, 'utf8'), 'existing-user-launcher')
  assert.equal(f.calls.some(call => call[0] === 'nix'), false)
  await assert.rejects(f.manager.check(), /not managed/)
  await rm(existing)
  await rm(join(f.manager.root, 'sources'), { recursive: true, force: true })
  await symlink('/tmp', join(f.manager.root, 'sources'))
  await assert.rejects(f.manager.install(f.original), /Unsafe installation directory/)
})


test('native CLI delegates noninteractive update checks to the real installer entry point', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  const before = await readFile(f.reference)
  const tools = join(f.root, 'tools')
  await mkdir(tools)
  await writeFile(join(tools, 'git'), `#!/bin/sh
[ "$1" = ls-remote ] || exit 97
printf 'ref: refs/heads/main\tHEAD\n${next}\tHEAD\n'
`, { mode: 0o755 })
  const concierge = join(tools, 'concierge')
  await writeFile(concierge, `#!/bin/sh
export PATH='${tools}:/bin:/usr/bin'
exec '${process.execPath}' /fixture/packages/app/dist/bin.mjs "$@"
`, { mode: 0o755 })
  const env = { ...process.env, HOME: f.home, XDG_DATA_HOME: '', DEARMACHINE_CONCIERGE_BIN: concierge, PATH: tools + ':/bin:/usr/bin' }
  const result = await exec('/fixture/dearmachine', ['update', '--check'], { env })
  assert.match(result.stdout, /Status: available/)
  assert.match(result.stdout, new RegExp(`Installed: ${old}`))
  assert.deepEqual(await readFile(f.reference), before)
  const structured = JSON.parse((await exec('/fixture/dearmachine', ['update', '--check', '--json'], { env })).stdout)
  assert.deepEqual(structured, { version: 1, operation: 'check', state: 'available', current: old, available: next })
  assert.deepEqual(JSON.parse((await exec('/fixture/dearmachine', ['update', '--json', '--check'], { env })).stdout), structured)
  const stopped = await exec('/fixture/dearmachine', ['_update-control', 'status'], { env })
  assert.deepEqual(JSON.parse(stopped.stdout), { running: false })
  await assert.rejects(exec('/fixture/dearmachine', ['update', '--check', '--recover'], { env }))
  const standard = { ...env, MACHTIANI_DISTRIBUTION: '/fixture/standard-distribution.json' }
  await assert.rejects(exec('/fixture/dearmachine', ['update', '--check'], { env: standard }), /Standard releases/)
  assert.deepEqual(JSON.parse((await exec('/fixture/dearmachine', ['update', '--check', '--json'], { env: standard })).stdout),
    { version: 1, operation: 'check', state: 'unsupported' })
  assert.deepEqual(JSON.parse((await exec('/fixture/dearmachine', ['update', '--json'], { env: standard })).stdout),
    { version: 1, operation: 'install', state: 'unsupported' })

  await writeFile(join(tools, 'git'), '#!/bin/sh\nexit 98\n', { mode: 0o755 })
  try {
    await exec('/fixture/dearmachine', ['update', '--check', '--json'], { env })
    assert.fail('failed structured check exited successfully')
  } catch (error) {
    assert.deepEqual(JSON.parse(error.stdout), { version: 1, operation: 'check', state: 'failed' })
  }
})



test('native update does not mistake its Nix runtime PATH for a competing installation', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  const before = await readFile(f.reference)
  const tools = join(f.root, 'tools')
  await mkdir(tools)
  await writeFile(join(tools, 'git'), `#!/bin/sh
[ "$1" = ls-remote ] || exit 97
printf 'ref: refs/heads/main\\tHEAD\\n${old}\\tHEAD\\n'
`, { mode: 0o755 })
  const concierge = join(tools, 'concierge')
  await writeFile(concierge, `#!/bin/sh
# Keep the production native wrapper's PATH additions; only fake remote lookup.
export PATH='${tools}':"$PATH"
exec '${process.execPath}' /fixture/packages/app/dist/bin.mjs "$@"
`, { mode: 0o755 })
  const env = { ...process.env, HOME: f.home, XDG_DATA_HOME: '', DEARMACHINE_CONCIERGE_BIN: concierge, PATH: join(f.home, '.local/bin') + ':/bin:/usr/bin' }
  const result = await exec('/fixture/dearmachine', ['update'], { env })
  assert.match(result.stdout, new RegExp(`Active release: ${old}`))
  assert.equal(result.stderr, '')
  assert.deepEqual(await readFile(f.reference), before)
})

test('reinstall updates the existing coordinated release without changing startup files', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  for (const file of ['.bashrc', '.profile', '.zshrc', '.zlogin']) await writeFile(join(f.home, file), 'user-owned-startup\n')
  await f.manager.install(f.original)
  const originalRun = f.manager.run
  const updated = new ManagedNix({ home: f.home, run: (command, args, cwd) => command === 'git' && args[2] === 'rev-parse' ? Promise.resolve(next + '\n') : originalRun(command, args, cwd) })
  f.control.running = true
  await updated.install(f.original)
  assert.equal(JSON.parse(await readFile(f.reference)).umbrellaRevision, next)
  assert.equal(f.control.running, true)
  for (const file of ['.bashrc', '.profile', '.zshrc', '.zlogin']) assert.equal(await readFile(join(f.home, file), 'utf8'), 'user-owned-startup\n')
  assert.equal((await readdir(join(f.home, '.local/bin'))).length, 5)
})

test('real Nix profile migration removes only the old package and works across shells without editing startup files', async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  await f.manager.install(f.original)
  const nix = process.env.NIX_PACKAGE + '/bin/nix'
  const nixStore = process.env.NIX_PACKAGE + '/bin/nix-store'
  const env = { HOME: f.home, PATH: process.env.NIX_PACKAGE + '/bin:/usr/bin:/bin', NIX_REMOTE: 'local', NIX_CONFIG: 'experimental-features = nix-command flakes\nsandbox = false\nbuild-users-group =\n' }
  const profile = join(f.home, '.local/state/nix/profiles/profile')
  await mkdir(dirname(profile), { recursive: true })
  const packages = {}
  for (const [name, programs] of [['legacy-dearmachine', ['dearmachine', 'agent-manager']], ['unrelated', ['keep-tool']], ['mixed', ['machtiani', 'keep-extra']]]) {
    const source = join(f.root, name)
    await mkdir(join(source, 'bin'), { recursive: true })
    for (const program of programs) await writeFile(join(source, 'bin', program), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    packages[name] = (await exec(nixStore, ['--add', source], { env })).stdout.trim()
    await exec(nix, ['profile', 'install', '--profile', profile, packages[name]], { env })
  }
  // Nix creates its default profile link even when installing into an explicit
  // profile. Point this disposable test home's link at the fixture profile.
  await rm(join(f.home, '.nix-profile'), { force: true })
  await symlink(profile, join(f.home, '.nix-profile'))
  assert.equal(await readlink(join(f.home, '.nix-profile')), profile)
  const inspect = async () => JSON.parse((await exec(nix, ['profile', 'list', '--profile', profile, '--json'], { env })).stdout)
  const before = await inspect()
  const entry = Object.keys(before.elements).find(name => before.elements[name].storePaths.includes(packages['legacy-dearmachine']))
  const mixed = Object.keys(before.elements).find(name => before.elements[name].storePaths.includes(packages.mixed))
  const startup = 'export PATH="$HOME/.nix-profile/bin:$HOME/.local/bin:/usr/bin:/bin"\n'
  for (const file of ['.bashrc', '.bash_profile', '.zshrc', '.zlogin']) await writeFile(join(f.home, file), startup)
  const cli = '/fixture/packages/app/dist/bin.mjs'
  const invoke = args => exec(process.execPath, [cli, ...args], { env })
  const initialProfile = await readlink(profile)
  const checked = await invoke(['migrate-profile', entry, '--check'])
  assert.match(checked.stdout, /Would remove/)
  assert.equal(await readlink(profile), initialProfile)
  await assert.rejects(invoke(['migrate-profile', mixed]), /other commands/)
  await assert.rejects(invoke(['migrate-profile', '--all']), /exact Nix profile entry/)
  assert.deepEqual(await inspect(), before)
  const result = await invoke(['migrate-profile', entry])
  assert.match(result.stdout, /Removed/)
  const after = await inspect()
  const expected = { ...before.elements }; delete expected[entry]
  assert.deepEqual(after.elements, expected)
  const shellEnv = { HOME: f.home, PATH: join(f.home, '.nix-profile/bin') + ':' + join(f.home, '.local/bin') + ':/usr/bin:/bin' }
  for (const [shell, flags] of [['/bin/sh', ['-c']], ['/bin/bash', ['-ic']], ['/bin/bash', ['-lic']], [process.env.ZSH_PACKAGE + '/bin/zsh', ['-ic']], [process.env.ZSH_PACKAGE + '/bin/zsh', ['-lic']]]) {
    await exec(shell, [...flags, 'test "$(command -v dearmachine)" = "$HOME/.local/bin/dearmachine"'], { env: shellEnv })
  }
  for (const file of ['.bashrc', '.bash_profile', '.zshrc', '.zlogin']) assert.equal(await readFile(join(f.home, file), 'utf8'), startup)
  const backupName = (await readdir(f.manager.root)).find(name => name.startsWith('profile-migration-'))
  const backup = JSON.parse(await readFile(join(f.manager.root, backupName, 'migration.json')))
  assert.equal(backup.status, 'complete')
  assert.deepEqual(backup.manifest, before)
  assert.ok(await readlink(join(f.manager.root, backupName, 'previous-profile')))
  // Recovery uses Nix's retained, exact generation; no unrelated package is lost.
  await exec(nix, ['profile', 'rollback', '--profile', profile, '--to', String(backup.generation)], { env })
  assert.deepEqual(await inspect(), before)
  const warning = await invoke(['_launcher-check'])
  // PATH here omits ~/.local/bin entirely; guidance must not create startup files.
  assert.match(warning.stderr, /another installation|Add \$HOME\/\.local\/bin/)
  for (const file of ['.bashrc', '.bash_profile', '.zshrc', '.zlogin']) assert.equal(await readFile(join(f.home, file), 'utf8'), startup)
})

for (const fail of [false, true]) test(`Machtiani first then DearMachine preserves data and launcher ownership (failure=${fail})`, async t => {
  const f = await fixture(); t.after(() => f.cleanup())
  const standalone = join(f.home, '.machtiani/installations/machtiani/profile/bin/machtiani')
  const launcher = join(f.home, '.local/bin/machtiani')
  await mkdir(dirname(standalone), { recursive: true })
  await writeFile(standalone, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await mkdir(dirname(launcher), { recursive: true })
  await symlink(standalone, launcher)
  const config = join(f.home, '.config/machtiani/config.toml')
  await mkdir(dirname(config), { recursive: true })
  await writeFile(config, 'existing configuration\n')
  // Fail after launchers switch, so rollback must restore the standalone link.
  if (fail) {
    const switchCurrent = f.manager.switchCurrent.bind(f.manager)
    f.manager.switchCurrent = async release => {
      await switchCurrent(release)
      // A competing file appears after preflight. Its place in command order
      // makes activation fail after the Machtiani link has been handed over.
      await writeFile(join(f.home, '.local/bin/machtiani-installer'), 'unrelated launcher')
    }
    await assert.rejects(f.manager.install(f.original))
    assert.equal(await readlink(launcher), standalone)
  } else {
    await f.manager.install(f.original)
    assert.equal(await readlink(launcher), join(f.manager.root, 'current/bin/machtiani'))
    assert.match(await readFile(join(f.manager.root, 'current/bin/machtiani'), 'utf8'), /export MACHTIANI_UPDATE_REEXEC=1/u)
    f.control.latest = next
    await f.manager.update()
    assert.equal(await readlink(launcher), join(f.manager.root, 'current/bin/machtiani'))
  }
  assert.equal(await readFile(config, 'utf8'), 'existing configuration\n')
  assert.equal(await readFile(standalone, 'utf8'), '#!/bin/sh\nexit 0\n')
})
