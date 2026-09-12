#!/usr/bin/env node
import { createConnection } from 'node:net'

const [kind, ...selectionParts] = process.argv.slice(2)
const actions = selectionParts.filter(value => value === '--replace' || value === '--use-existing')
const action = actions[0] === '--replace' ? 'replace' : actions[0] === '--use-existing' ? 'use-existing' : 'ensure'
const selection = selectionParts.filter(value => value !== '--replace' && value !== '--use-existing').join(' ').trim()
const socketPath = process.env.MACHTIANI_INSTALLER_CREDENTIAL_SOCKET

if ((kind !== 'backend-provider' && kind !== 'machtiani-provider' && kind !== 'email') || actions.length > 1 || selection === '' || socketPath === undefined || socketPath === '') {
  process.stderr.write('Usage: machtiani-installer-credential <backend-provider|machtiani-provider|email> <provider-or-transport> [--use-existing|--replace]\n')
  process.exitCode = 2
} else {
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  let input = ''
  socket.once('connect', () => {
    socket.write(`${JSON.stringify({ kind, selection, action })}\n`)
  })
  socket.on('data', chunk => {
    input += chunk
    const newline = input.indexOf('\n')
    if (newline < 0) return
    socket.end()
    try {
      const response = JSON.parse(input.slice(0, newline)) as { ok?: boolean; status?: string; error?: string; reference?: unknown }
      if (response.ok === true && response.status === 'already-present') {
        process.stdout.write('Credential is already available.\n')
      } else if (response.ok === true && response.status === 'configured') {
        process.stdout.write('Machtiani provider now references the saved credential variable. Its runtime must load the referenced environment file. Authentication has not been tested; no client restart was performed.\n')
      } else if (response.ok === true && response.status === 'saved') {
        process.stdout.write('Credential saved securely.\n')
      } else if (response.ok === true && response.status === 'cancelled') {
        process.stdout.write("Credential entry was cancelled. Do not continue this credential step; wait for the human's next message.\n")
      } else {
        process.stderr.write(`${response.error ?? 'Credential entry failed.'}\n`)
        process.exitCode = 1
      }
      if (response.ok === true && (response.status === 'configured' || response.status === 'saved' || response.status === 'already-present') && response.reference !== undefined) {
        process.stdout.write(`Credential reference (not a value): ${JSON.stringify(response.reference)}\n`)
      }
    } catch {
      process.stderr.write('Credential entry returned an invalid response.\n')
      process.exitCode = 1
    }
  })
  socket.once('error', () => {
    process.stderr.write('The Machtiani Installer credential field is unavailable.\n')
    process.exitCode = 1
  })
}
