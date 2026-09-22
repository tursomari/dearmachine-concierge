import { lstat, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'

export function managedModelAliases(): string {
  return [ ['dearmachine', 'planner'], ['dearmachine-shell-agent', 'shell-agent'], ['dearmachine-sync', 'sync'] ]
    .map(([alias, component]) => `[models.${alias}]\nprovider = "dearmachine-host"\nmodel = "@machtiani/${component}"\ncontext_length = 131072\n`).join('\n')
}

/** Upgrade only the installer-owned model blocks, preserving unrelated configuration.
 * Selectors also resolve against legacy profiles, so this can precede the atomic selection write.
 */
export async function upgradeManagedModelConfig(home: string, profilePath: string): Promise<void> {
  const path = join(home, '.config', 'dearmachine', 'machtiani', 'config.toml')
  let content: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || !await hasPrivatePermissions(path)) throw new Error('Unsafe managed configuration.')
    content = await readFile(path, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const sections = content.split(/(?=^\[)/mu)
  const provider = sections.find(section => section.startsWith('[providers.dearmachine-host]\n'))
  if (!provider?.includes('transport = "model-host"') || !provider.includes(`profile = ${JSON.stringify(profilePath)}`)) {
    throw new Error('The managed configuration is customized; retain it and configure model-host routing before changing shared models.')
  }
  const header = sections[0] ?? ''
  for (const key of ['default_model', 'answer_model', 'file_discovery_model']) {
    if (!header.split(/\r?\n/u).includes(`${key} = "dearmachine"`)) throw new Error('The managed model roles are customized.')
  }
  const generated = managedModelAliases().trim().split('\n\n')
  if (generated.every(block => sections.some(section => section.trim() === block))) {
    if (!/^shell_agent_model = "dearmachine-shell-agent"$/mu.test(header)) throw new Error('The shell-agent model role is customized.')
    if (sections.some(section => /^\[models\.dearmachine(?:-shell-agent|-sync)?\./u.test(section))) throw new Error('The managed model parameters are customized.')
    return
  }
  if (!/^shell_agent_model = "dearmachine"$/mu.test(header)) throw new Error('The shell-agent model role is customized.')
  const owned = sections.filter(section => /^\[models\.dearmachine(?:\]|\.)/u.test(section))
  for (const section of owned) {
    const lines = section.trim().split('\n').map(line => line.trim()).filter(Boolean)
    const expected = lines[0] === '[models.dearmachine]'
      ? [/^provider = "dearmachine-host"$/u, /^model = "(?:[^"\\]|\\.)+"$/u, /^context_length = 131072$/u]
      : lines[0] === '[models.dearmachine.params.reasoning]' ? [/^effort = "(?:[^"\\]|\\.)+"$/u] : []
    if (lines.length !== expected.length + 1 || !expected.every(pattern => lines.slice(1).some(line => pattern.test(line)))) throw new Error('The managed model parameters are customized.')
  }
  if (!sections.some(section => section.startsWith('[models.dearmachine]\n') && section.includes('provider = "dearmachine-host"'))) throw new Error('The managed model is customized.')
  if (sections.some(section => /^\[models\.dearmachine-(?:shell-agent|sync)[.\]]/u.test(section))) throw new Error('Reserved managed aliases already exist.')
  const next = sections.filter(section => !/^\[models\.dearmachine(?:\]|\.)/u.test(section)).join('')
    .replace(/^shell_agent_model = "dearmachine"$/mu, 'shell_agent_model = "dearmachine-shell-agent"')
    .trimEnd() + '\n\n' + managedModelAliases()
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: 'wx' })
    await protectPrivatePath(temporary, 0o600)
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}
