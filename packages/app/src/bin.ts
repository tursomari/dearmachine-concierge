#!/usr/bin/env node
import { runInstaller, runMockInstaller } from './index.ts'

export type InstallerInvocation = { mode: 'mock' } | { mode: 'install'; sourceRoot: string }

export function parseArguments(args: readonly string[]): InstallerInvocation {
  if (args.length === 1 && args[0] === '--mock') return { mode: 'mock' }
  if (args.length === 3 && args[0] === '--install' && args[1] === '--source-root' && args[2] !== '') {
    return { mode: 'install', sourceRoot: args[2]! }
  }
  throw new Error('Usage: machtiani-installer --install --source-root /absolute/path/to/machtiani\n       machtiani-installer --mock')
}

async function main(): Promise<void> {
  const invocation = parseArguments(process.argv.slice(2))
  await (invocation.mode === 'mock' ? runMockInstaller() : runInstaller(invocation.sourceRoot))
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
