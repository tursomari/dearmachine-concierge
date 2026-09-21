import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { decodeZstdFrames } from './zstd-frames.mjs'

test('includes credential sentinels in later appended trajectory frames', () => {
  const frames = ['{"type":"session"}\n', '{"text":"counterfeit-private-sentinel"}\n', '{"type":"turn/end"}\n']
  const decoded = decodeZstdFrames(Buffer.concat(frames.map(frame => zstdCompressSync(frame)))).toString()
  assert.equal(decoded, frames.join(''))
  assert.ok(decoded.includes('counterfeit-private-sentinel'))
})

test('refuses empty or invalid trailing evidence instead of accepting its first frame', () => {
  const first = zstdCompressSync('header')
  for (const bytes of [Buffer.alloc(0), Buffer.concat([first, Buffer.from('garbage')])]) {
    assert.throws(() => decodeZstdFrames(bytes))
  }
})
