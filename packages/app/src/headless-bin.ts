#!/usr/bin/env node
import { parseHeadlessArguments, runHeadlessProductInstallation } from './headless.ts'

async function main(): Promise<void> {
  const invocation = parseHeadlessArguments(process.argv.slice(2))
  const result = await runHeadlessProductInstallation(invocation.sourceRoot, invocation.selectionFile, invocation.existingInboxId)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Headless product installation failed.'}\n`)
  process.exitCode = 1
})
