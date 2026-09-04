import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'machtiani-installer-tools'
export const inject = ['tools', 'systemPrompt']

export type InstallationOutcomeKind = 'success' | 'partial' | 'blocked'

export interface InstallationOutcome {
  version: 1
  outcome: InstallationOutcomeKind
  summary: string
  remainingAction?: string
  receipts: readonly string[]
}

export async function saveInstallationOutcome(path: string, outcome: InstallationOutcome): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(outcome, undefined, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

export function apply(ctx: Context): void {
  const outcomePath = process.env.MACHTIANI_INSTALLER_OUTCOME
  if (outcomePath === undefined || outcomePath === '') throw new Error('MACHTIANI_INSTALLER_OUTCOME is required')
  ctx.systemPrompt.section({
    name: 'tool:machtiani-installer-finish',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: 'When installation reaches a terminal success, partial, or blocked state, call finish_installation exactly once. Base every receipt on observed command evidence. Distinguish pre-existing software from installer changes. Do not place credentials or credential fragments in any field.',
  })
  ctx.tools.register(defineTool({
    name: 'finish_installation',
    description: 'Finish the guided installer with a structured, evidence-based outcome. This closes the installer session.',
    parameters: {
      outcome: { type: 'string', required: true, enum: ['success', 'partial', 'blocked'] },
      summary: { type: 'string', required: true, description: 'Short plain-language outcome.' },
      remaining_action: { type: 'string', description: 'One actionable next step when incomplete.' },
      receipts: {
        type: 'array', required: true,
        items: { type: 'string' },
        description: 'Observed facts, including whether each component was pre-existing, installed, configured, or verified.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { recorded: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'The installer outcome was recorded and the session will close.' }],
    },
    async execute(args) {
      await saveInstallationOutcome(outcomePath, {
        version: 1,
        outcome: args.outcome as InstallationOutcomeKind,
        summary: args.summary,
        ...(args.remaining_action === undefined ? {} : { remainingAction: args.remaining_action }),
        receipts: args.receipts,
      })
      return { recorded: true }
    },
    presentCall: () => ({ card: 'generic', title: 'Finish installation', kind: 'other' }),
  }))
}
