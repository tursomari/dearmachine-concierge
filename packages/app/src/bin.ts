#!/usr/bin/env node
import { entryHelp, parseInvocation } from './concierge-entry.ts'
import { executeDaemonCommand } from './concierge-shell.ts'
import { SocketDaemonControl } from './concierge-control.ts'

export { parseInvocation as parseArguments } from './concierge-entry.ts'
export type { InstallerInvocation } from './concierge-entry.ts'

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2))
  if (invocation.mode === 'help' || (invocation.mode === 'concierge' && (!process.stdin.isTTY || !process.stdout.isTTY))) {
    process.stdout.write(entryHelp)
    return
  }
  if (invocation.mode === 'control') {
    const control = new SocketDaemonControl()
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
