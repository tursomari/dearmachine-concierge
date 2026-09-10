#!/usr/bin/env node
import { entryHelp, parseInvocation } from './concierge-entry.ts'
import { executeDaemonCommand } from './concierge-shell.ts'
import { defaultConciergeControl } from './concierge-control.ts'
import { launchEnvironment } from './launch-environment.ts'

export { parseInvocation as parseArguments } from './concierge-entry.ts'
export type { InstallerInvocation } from './concierge-entry.ts'

async function main(): Promise<void> {
  process.env.PATH = launchEnvironment(process.env).PATH
  const invocation = parseInvocation(process.argv.slice(2), process.stdin.isTTY && process.stdout.isTTY ? process.env : {})
  if (invocation.mode === 'help' || (invocation.mode === 'concierge' && (!process.stdin.isTTY || !process.stdout.isTTY))) {
    process.stdout.write(entryHelp)
    return
  }
  if (invocation.mode === 'control') {
    const control = defaultConciergeControl()
    const result = await executeDaemonCommand(control, invocation.command)
    ;(result.code === 0 ? process.stdout : process.stderr).write(result.message + '\n')
    process.exitCode = result.code
    return
  }
  if (invocation.mode === 'concierge') {
    const { launchConcierge } = await import('./concierge.ts')
    await launchConcierge(invocation.sourceRoot)
    return
  }
  const { runInstaller, runMockInstaller } = await import('./index.ts')
  await (invocation.mode === 'mock' ? runMockInstaller() : runInstaller(invocation.sourceRoot))
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
