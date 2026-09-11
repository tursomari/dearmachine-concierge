import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'machtiani-management-tools'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:request-dearmachine-update',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: 'For a natural-language request to check for Dear Machine updates or install one, call request_dearmachine_update exactly once. Choose check for inspection only and install when the human asked to update. This tool never installs directly; the application owns the native command, explicit installation consent, and result presentation.',
  })
  ctx.tools.register(defineTool({
    name: 'request_dearmachine_update',
    description: 'Route a Dear Machine update check or install request to the deterministic concierge update flow.',
    parameters: {
      action: { type: 'string', required: true, enum: ['check', 'install'] },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { routed: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'The concierge accepted the update request and will present the authoritative result.' }],
    },
    async execute() { return { routed: true } },
    presentCall: () => ({ card: 'generic', title: 'Dear Machine update', kind: 'other' }),
  }))
}
