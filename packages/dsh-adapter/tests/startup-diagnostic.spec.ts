import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { spawn } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { DshAgentSession } from '../src/index.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

it('drains late startup stderr before the caller saves its diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'machtiani-startup-diagnostic-'))
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(data, _encoding, callback) {
      const request = JSON.parse(String(data)) as { id: number }
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, error: { message: 'no adapter registered' } }) + '\n'))
      setTimeout(() => child.stderr.write('plugin tree failed: libresolv.so.2 could not be loaded\n'), 10)
      setTimeout(() => child.emit('close', 1), 20)
      callback()
    } }),
    kill: vi.fn(),
  })
  vi.mocked(spawn).mockReturnValue(child as never)
  const session = new DshAgentSession({ dshHome: join(root, 'dsh'), workspace: root,
    modelProfilePath: join(root, 'profile.json'), outcomePath: join(root, 'outcome.json') })
  await expect(session.start()).rejects.toThrow('no adapter registered')
  expect(session.privateDiagnostic().stderr).toContain('libresolv.so.2')
  expect(child.kill).not.toHaveBeenCalled()
  await session.shutdown()
})
