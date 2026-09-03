#!/usr/bin/env node
import { runMockInstaller } from './index.ts'

if (!process.argv.includes('--mock')) {
  process.stderr.write('Machtiani is starting its installation assistant. This build contains only the no-change preview; run with --mock.\n')
  process.exitCode = 2
} else {
  runMockInstaller().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
