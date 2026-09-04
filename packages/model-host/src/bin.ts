#!/usr/bin/env node
import { serveModelHost } from './index.ts'

const profileFlag = process.argv.indexOf('--profile')
const profilePath = profileFlag >= 0 ? process.argv[profileFlag + 1] : process.env.MACHTIANI_MODEL_PROFILE
if (profilePath === undefined || profilePath === '') {
  process.stderr.write('Usage: machtiani-model-host --profile <private-profile.json>\n')
  process.exitCode = 2
} else {
  await serveModelHost(profilePath).catch(() => {
    process.stderr.write('The Machtiani model host stopped unexpectedly.\n')
    process.exitCode = 1
  })
}
