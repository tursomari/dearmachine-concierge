#!/usr/bin/env node
import { serveModelHost } from './index.ts'
import { runInteractiveModelHostAuth } from './cli.ts'

const args = process.argv.slice(2)
if (args[0] === 'auth') {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.exitCode = await runInteractiveModelHostAuth(args, process.stdin, process.stdout, process.stderr, undefined, controller.signal)
} else {
  const profileFlag = args.indexOf('--profile')
  const profilePath = profileFlag >= 0 ? args[profileFlag + 1] : process.env.MACHTIANI_MODEL_PROFILE
  if (profilePath === undefined || profilePath === '') {
    process.stderr.write('Usage: machtiani-model-host --profile <private-profile.json>\n')
    process.exitCode = 2
  } else {
    await serveModelHost(profilePath).catch(() => {
      process.stderr.write('The Machtiani model host stopped unexpectedly.\n')
      process.exitCode = 1
    })
  }
}
