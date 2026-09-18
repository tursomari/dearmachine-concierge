import { spawn } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AgentManagerBackendAdapter } from '@dearmachine/machtiani-installer-backends'
import { ClaudeCliAuth } from '@dearmachine/machtiani-model-host'
import type { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { authEvent, authPrompt } from './model-wizard.ts'

/** Backend account login uses its own executable/profile, never the installer's model profile. */
export async function authenticateClaudeBackend(tui: InstallerTui, home: string, signal: AbortSignal, selectedExecutable?: string): Promise<void> {
  signal.throwIfAborted()
  const selected = selectedExecutable ?? (await new AgentManagerBackendAdapter().discover()).find(item => item.id === 'claude')?.executable
  if (!selected) throw new Error('Install the selected Claude Code backend before signing in.')
  if (!isAbsolute(selected)) throw new Error('The Claude Code executable must be an absolute path.')
  await access(selected, constants.X_OK)
  const executable = await realpath(selected)
  const profile = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const cancellation = new AbortController()
  const authentication = AbortSignal.any([signal, cancellation.signal, AbortSignal.timeout(10 * 60_000)])
  const auth = new ClaudeCliAuth((target, args) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: target }
    delete environment.ANTHROPIC_API_KEY
    delete environment.ANTHROPIC_AUTH_TOKEN
    delete environment.CLAUDE_CODE_OAUTH_TOKEN
    return spawn(executable, [...args], { env: environment, signal: authentication, stdio: ['pipe', 'pipe', 'pipe'] })
  })
  const scope = tui.beginCancellationScope(() => cancellation.abort())
  const interaction = tui.beginExternalWait('Complete Claude Code sign-in in your browser')
  try {
    await auth.login(profile, {
      signal: authentication,
      notify: event => authEvent(tui, event),
      prompt: async prompt => { interaction.close(); return await authPrompt(tui, prompt, authentication) },
    })
  } finally { interaction.close(); scope.close(); tui.setProgress(undefined) }
}
