import type { Context } from '@deepseek-ai/cordis'
import { conciergeRole, registerSharedFoundation } from './system-prompts.ts'

export const name = 'machtiani-management-system-prompt'
export const inject = ['systemPrompt']

export function apply(ctx: Context): void {
  registerSharedFoundation(ctx)
  ctx.systemPrompt.section({
    name: 'machtiani:concierge-role',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA') + 10,
    text: conciergeRole,
  })
}
