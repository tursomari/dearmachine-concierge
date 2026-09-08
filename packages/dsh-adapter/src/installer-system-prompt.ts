import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { installerRole, registerSharedFoundation } from './system-prompts.ts'

export const name = 'machtiani-installer-system-prompt'
export const inject = ['systemPrompt']

export function apply(ctx: Context): void {
  const contractPath = process.env.MACHTIANI_INSTALLER_CONTRACT
  if (contractPath === undefined || contractPath === '') throw new Error('MACHTIANI_INSTALLER_CONTRACT is required')
  const baseOrder = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA')
  registerSharedFoundation(ctx)
  ctx.systemPrompt.section({ name: 'machtiani:installer-role', order: baseOrder + 10, text: installerRole })
  ctx.systemPrompt.section({
    name: 'machtiani:installation-contract',
    order: baseOrder + 20,
    text: `<installation_contract>\n${readFileSync(contractPath, 'utf8')}\n</installation_contract>`,
  })
}
