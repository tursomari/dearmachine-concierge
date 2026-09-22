import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Mirrors Dear Machine's device-config backend array, not executable discovery.
 * No backend is launched and no backend-owned configuration is written.
 */
export async function configuredBackendModels(home: string, _environment: NodeJS.ProcessEnv): Promise<string[]> {
  let content: string
  try { content = await readFile(join(home, '.dearmachine', 'config', 'dearmachine.toml'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const entries = content.split(/\r?\n/u).filter(line => /^\s*backends\s*=/u.test(line))
  if (entries.length !== 1 || !/^\s*version\s*=\s*1\s*$/mu.test(content)) throw new Error('Invalid backend configuration.')
  const ids: unknown = JSON.parse(entries[0]!.slice(entries[0]!.indexOf('=') + 1))
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id))) throw new Error('Invalid configured backends.')
  return [...new Set(ids as string[])].map(raw => {
    const id = raw === 'forgecode' ? 'forge' : raw
    switch (id) {
      // Native adapters pass no model flags for these three backends. Do not
      // mistake a partial global config for their effective project selection.
      case 'codex': case 'codex-yolo': return `${id}: model not determined. Change the Codex CLI's own model configuration; consult codex --help for its configuration options.`
      case 'forge': return 'Forge: model not determined. Change its default with forge config set model <provider> <model>; inspect it with forge config get model --porcelain.'
      case 'omp': return 'OMP: model not determined. Change provider, model and reasoning in OMP’s own configuration; consult omp --help for the installed version.'
      // The running manager can have a different environment from Concierge.
      case 'claude': return 'Claude Code: model not determined. Set DEARMACHINE_CLAUDE_MODEL in the Agent Manager launch environment. Its adapter uses that value, then ANTHROPIC_MODEL, then sonnet as the fallback.'
      default: return `${id}: model not determined. Inspect this backend's command in custom-backends.toml and change the configuration owned by that command.`
    }
  })
}
