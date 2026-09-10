import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Invocation metadata only; never credential values or a copied auth profile. */
export function credentialRuntimeContext(helper = fileURLToPath(new URL('./credential-bin.mjs', import.meta.url))) {
  return {
    credentialHelper: {
      email: [process.execPath, helper, 'email', '<selected transport>'],
      backendProvider: [process.execPath, helper, 'backend-provider', '<selected backend provider>'],
    },
    backendPreparations: {
      forge: {
        supportedVersion: '2.13.21',
        invocation: [process.execPath, join(dirname(createRequire(import.meta.url).resolve('@dearmachine/machtiani-installer-backends')), 'bin.mjs'), 'prepare-forge-2.13.21'],
        makesProviderRequest: true,
      },
    },
  }
}

export type CredentialRuntimeContext = ReturnType<typeof credentialRuntimeContext>
