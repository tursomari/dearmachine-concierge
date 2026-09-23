import { lstat, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'

const aliases = [['dearmachine', 'planner'], ['dearmachine-shell-agent', 'shell-agent'], ['dearmachine-sync', 'sync']] as const
export function managedModelAliases(): string {
  return aliases.map(([alias, component]) => `[models.${alias}]\nprovider = "dearmachine-host"\nmodel = "@machtiani/${component}"\ncontext_length = 131072\n`).join('\n')
}

/** Upgrade only the installer-owned model blocks, preserving unrelated configuration.
 * Accept both the published template and Machtiani config import's indented layout.
 * Selectors resolve against legacy profiles too, before the atomic selection write.
 */
export async function upgradeManagedModelConfig(home: string, profilePath: string): Promise<void> {
  const path = join(home, '.config', 'dearmachine', 'machtiani', 'config.toml')
  let content: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || !await hasPrivatePermissions(path)) throw new Error('Unsafe managed configuration.')
    content = await readFile(path, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const sections = content.split(/(?=^[\t ]*\[)/mu).map(raw => ({
    raw, lines: raw.trim().split('\n').map(line => line.trim()).filter(Boolean),
  }))
  const named = (name: string) => sections.filter(section => section.lines[0] === `[${name}]`)
  const provider = named('providers.dearmachine-host')
  const homeProfile = relative(home, profilePath).split('\\').join('/')
  const profiles = [`profile = ${JSON.stringify(profilePath)}`]
  if (!homeProfile.startsWith('../')) profiles.push(`profile = ${JSON.stringify(`~/${homeProfile}`)}`)
  if (provider.length !== 1 || !provider[0]!.lines.includes('transport = "model-host"') ||
      !profiles.some(line => provider[0]!.lines.includes(line))) {
    throw new Error('The managed configuration is customized; retain it and configure model-host routing before changing shared models.')
  }
  const header = sections[0]?.lines ?? []
  for (const key of ['default_model', 'answer_model', 'file_discovery_model']) {
    if (!header.includes(`${key} = "dearmachine"`)) throw new Error('The managed model roles are customized.')
  }
  const owned = sections.filter(section => /^\[models\.dearmachine(?:-shell-agent|-sync)?(?:\]|\.)/u.test(section.lines[0] ?? ''))
  const dynamic = aliases.every(([alias, component]) => {
    const matches = named(`models.${alias}`)
    return matches.length === 1 && matches[0]!.lines.length === 4 && [
      'provider = "dearmachine-host"', `model = "@machtiani/${component}"`, 'context_length = 131072',
    ].every(line => matches[0]!.lines.includes(line))
  })
  if (dynamic) {
    if (!header.includes('shell_agent_model = "dearmachine-shell-agent"')) throw new Error('The shell-agent model role is customized.')
    if (owned.length !== aliases.length) throw new Error('The managed model parameters are customized.')
    return
  }
  if (!header.includes('shell_agent_model = "dearmachine"')) throw new Error('The shell-agent model role is customized.')
  if (named('models.dearmachine').length !== 1) throw new Error('The managed model is customized.')
  const seen = new Set<string>()
  for (const section of owned) {
    const [title, ...lines] = section.lines
    if (title === undefined || seen.has(title)) throw new Error('The managed model parameters are customized.')
    seen.add(title)
    const expected = title === '[models.dearmachine]'
      ? [/^provider = "dearmachine-host"$/u, /^model = "(?:[^"\\]|\\.)+"$/u, /^context_length = 131072$/u]
      : title === '[models.dearmachine.params.reasoning]' ? [/^effort = "(?:[^"\\]|\\.)+"$/u]
        : title === '[models.dearmachine.params]' ? [] : undefined
    if (expected === undefined || lines.length !== expected.length ||
        !expected.every(pattern => lines.some(line => pattern.test(line)))) throw new Error('The managed model parameters are customized.')
  }
  const next = sections.filter(section => !owned.includes(section)).map(section => section.raw).join('')
    .replace(/^[\t ]*shell_agent_model = "dearmachine"$/mu, 'shell_agent_model = "dearmachine-shell-agent"')
    .trimEnd() + '\n\n' + managedModelAliases()
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: 'wx' })
    await protectPrivatePath(temporary, 0o600)
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}
