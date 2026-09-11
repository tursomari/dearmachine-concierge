import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Read-only diagnostics. Startup files and unrelated packages belong to the user. */
export async function launcherGuidance(home: string, path: string): Promise<string[]> {
  const messages: string[] = []
  for (const name of ['dearmachine', 'machtiani', 'agent-manager', 'machtiani-installer', 'machtiani-model-host']) {
    const expected = join(home, '.local/bin', name)
    const target = await realpath(expected).catch(() => undefined)
    if (!target) continue
    let found: string | undefined
    for (const directory of path.split(':')) {
      if (!directory || !isAbsolute(directory)) continue
      const candidate = join(directory, name)
      try { await access(candidate, constants.X_OK); found = candidate; break } catch {}
    }
    if (!found) messages.push(`${name} is installed at ${expected}. Add $HOME/.local/bin to your shell's PATH, or use that absolute command.`)
    else if (await realpath(found) !== target) messages.push(`${name} resolves to another installation: ${found}. Use ${expected}; inspect and remove the superseded installation through its package manager. For an old Nix profile entry, run machtiani-installer migrate-profile <entry> --check first.`)
  }
  return messages
}
