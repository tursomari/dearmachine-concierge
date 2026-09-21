import { zstdDecompressSync } from 'node:zlib'

// DSH appends one independently compressed frame per session event. Node's
// decoder stops after the first frame, so consume every frame explicitly.
export function decodeZstdFrames(bytes) {
  if (bytes.length === 0) throw new Error('Empty compressed evidence')
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), { info: true })
    const consumed = engine.bytesWritten
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > bytes.length - offset) {
      throw new Error('Invalid compressed evidence frame length')
    }
    frames.push(buffer)
    offset += consumed
  }
  return Buffer.concat(frames)
}
