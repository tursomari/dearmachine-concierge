#!/usr/bin/env node
import { prepareForge21321 } from './index.ts'

function value(name: string): string {
  const index = process.argv.indexOf(name)
  const result = index < 0 ? undefined : process.argv[index + 1]
  if (result === undefined || result === '' || result.startsWith('--')) throw new Error(`Missing ${name}.`)
  return result
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'prepare-forge-2.13.21') {
    throw new Error('Usage: machtiani-installer-backend prepare-forge-2.13.21 --home PATH --environment-file PATH --provider ID --model ID')
  }
  const receipt = await prepareForge21321({
    home: value('--home'),
    providerEnvironmentPath: value('--environment-file'),
    provider: value('--provider'),
    model: value('--model'),
  })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
