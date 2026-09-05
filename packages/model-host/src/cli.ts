import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import {
  ModelHost,
  ModelHostError,
  type ModelHostAuthEvent,
  type ModelHostAuthInteraction,
  type ModelHostLoginMode,
} from './index.ts'

type InteractiveHost = Pick<ModelHost, 'login' | 'profile'>

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function authUsage(errors: Writable): void {
  errors.write('Usage: machtiani-model-host auth login --profile <private-profile.json> [--mode <browser|device_code>]\n')
}

function renderAuthEvent(errors: Writable, event: ModelHostAuthEvent): void {
  switch (event.type) {
    case 'auth_url':
      if (event.instructions !== undefined) errors.write(`${event.instructions}\n`)
      errors.write(`${event.url}\n`)
      break
    case 'device_code':
      errors.write(`Open ${event.verificationUri} and enter code ${event.userCode}.\n`)
      break
    case 'info':
      errors.write(`${event.message}\n`)
      for (const link of event.links ?? []) errors.write(`${link.label === undefined ? '' : `${link.label}: `}${link.url}\n`)
      break
    case 'progress':
      errors.write(`${event.message}\n`)
      break
  }
}

export async function runInteractiveModelHostAuth(
  args: readonly string[],
  input: Readable,
  output: Writable,
  errors: Writable,
  openHost: (path: string) => Promise<InteractiveHost> = ModelHost.open,
  signal?: AbortSignal,
): Promise<number> {
  if (args[0] !== 'auth' || args[1] !== 'login') {
    authUsage(errors)
    return 2
  }
  const profilePath = option(args, '--profile')
  if (profilePath === undefined || profilePath.trim() === '') {
    authUsage(errors)
    return 2
  }
  const rawMode = option(args, '--mode') ?? 'browser'
  const mode = rawMode === 'device-code' ? 'device_code' : rawMode
  if (mode !== 'browser' && mode !== 'device_code') {
    errors.write('Authentication mode must be browser or device_code.\n')
    return 2
  }
  const known = new Set(['auth', 'login', '--profile', profilePath, '--mode', rawMode])
  if (args.some(value => !known.has(value))) {
    authUsage(errors)
    return 2
  }

  let host: InteractiveHost
  try { host = await openHost(profilePath) } catch (error) {
    errors.write(`Authentication failed: ${error instanceof Error ? error.message : 'the private provider profile could not be opened.'}\n`)
    return 1
  }
  if (host.profile.authMethod !== 'subscription') {
    errors.write('Interactive model-host login is available only for subscription providers.\n')
    return 1
  }

  const lines = createInterface({ input, output: errors, terminal: false })
  const interaction: ModelHostAuthInteraction = {
    ...(signal === undefined ? {} : { signal }),
    notify: event => renderAuthEvent(errors, event),
    prompt: async prompt => {
      if (prompt.type === 'secret') throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'Secret authentication input must use the installer secure field.')
      return (await lines.question(`${prompt.message} `, { signal: prompt.signal ?? signal })).trim()
    },
  }
  try {
    await host.login(interaction, mode as ModelHostLoginMode)
    output.write(`Authentication completed for ${host.profile.provider}.\n`)
    return 0
  } catch (error) {
    const detail = error instanceof ModelHostError ? `${error.message} (${error.code})` : 'The provider-owned sign-in did not complete.'
    errors.write(`Authentication failed: ${detail}\n`)
    return 1
  } finally {
    lines.close()
  }
}
