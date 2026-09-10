import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { CredentialBoundary, CREDENTIAL_BLOCKED, CREDENTIAL_UNAVAILABLE } from './credential-boundary.ts'

export const name = 'machtiani-credential-policy'
export const inject = ['tools', 'llm']

export async function apply(ctx: Context): Promise<void> {
  const home = process.env.HOME
  if (!home) throw new Error(CREDENTIAL_UNAVAILABLE)
  const boundary = new CredentialBoundary({ home, environment: process.env,
    ...(process.env.MACHTIANI_MODEL_PROFILE ? { profile: process.env.MACHTIANI_MODEL_PROFILE } : {}) })
  await boundary.refresh()

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      await boundary.refresh()
      if (boundary.containsCredential(exec.arguments)) return { kind: 'deny', reason: CREDENTIAL_BLOCKED }
      if (['read', 'write', 'edit', 'multiedit'].includes(exec.name)) {
        const args = exec.arguments as Record<string, unknown>
        const cwd = exec.agent?.session.header.cwd ?? process.cwd()
        for (const field of ['file_path', 'path', 'filePath']) {
          if (typeof args[field] === 'string' && await boundary.protectedPath(args[field], cwd)) return { kind: 'deny', reason: CREDENTIAL_BLOCKED }
        }
      }
      return await next()
    } catch { return { kind: 'deny', reason: CREDENTIAL_UNAVAILABLE } }
  })

  ctx.on('tools/post-execute', async (_exec, result, next) => {
    try {
      await boundary.refresh()
      const decision = await next()
      if (!boundary.containsCredential(result) && !boundary.containsCredential(decision)) return decision
      // Block the entire result. Replacing content alone leaves raw value/meta
      // and errors available to session persistence and presentation plugins.
      return { kind: 'block', feedback: [{ type: 'text', text: CREDENTIAL_BLOCKED }] }
    } catch { return { kind: 'block', feedback: [{ type: 'text', text: CREDENTIAL_UNAVAILABLE }] } }
  })

  ctx.on('llm/stream', async function* (options, next) {
    await boundary.refresh()
    if (boundary.containsCredential(options)) throw new Error(CREDENTIAL_BLOCKED)
    yield* next()
  })
}
