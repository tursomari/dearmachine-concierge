#!/usr/bin/env node
import { createConnection } from 'node:net'

const [kind, ...selectionParts] = process.argv.slice(2)
const selection = selectionParts.join(' ').trim()
const socketPath = process.env.MACHTIANI_INSTALLER_CREDENTIAL_SOCKET

if ((kind !== 'llm' && kind !== 'email') || selection === '' || socketPath === undefined || socketPath === '') {
  process.stderr.write('Usage: machtiani-installer-credential <llm|email> <provider-or-transport>\n')
  process.exitCode = 2
} else {
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  let input = ''
  socket.once('connect', () => {
    socket.write(`${JSON.stringify({ kind, selection })}\n`)
  })
  socket.on('data', chunk => {
    input += chunk
    const newline = input.indexOf('\n')
    if (newline < 0) return
    socket.end()
    try {
      const response = JSON.parse(input.slice(0, newline)) as { ok?: boolean; status?: string; error?: string }
      if (response.ok === true) process.stdout.write(response.status === 'already-present' ? 'Credential is already available.\n' : 'Credential saved securely.\n')
      else {
        process.stderr.write(`${response.error ?? 'Credential entry failed.'}\n`)
        process.exitCode = 1
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
