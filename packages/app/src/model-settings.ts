import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { effectiveModelProfile, loadModelHostProfile, saveModelHostProfile, type ModelComponent, type ModelHostProfile } from '@dearmachine/machtiani-model-host'
import { upgradeManagedModelConfig } from '@dearmachine/machtiani-installer-products'

export const assistantModelPath = (home: string): string => join(home, '.config', 'dearmachine', 'assistant-model.json')
export const sharedModelPath = (home: string): string => join(home, '.config', 'machtiani', 'model-profile.json')
async function optionalProfile(path: string): Promise<ModelHostProfile | undefined> {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return loadModelHostProfile(path)
}

/** Reading does not migrate or freeze inheritance. A legacy Concierge choice is retained. */
export async function loadModelSettings(home: string): Promise<ModelHostProfile | undefined> {
  const shared = await optionalProfile(sharedModelPath(home))
  if (shared?.selectionVersion === 1) return shared
  const assistant = await optionalProfile(assistantModelPath(home))
  const fallback = shared ?? assistant
  if (fallback === undefined) return undefined
  return { ...fallback, selectionVersion: 1, overrides: assistant === undefined || shared === undefined ? {} : { concierge: assistant } }
}

export type ModelTarget = 'default' | 'all' | ModelComponent
export async function saveModelSettings(home: string, target: ModelTarget, profile?: ModelHostProfile): Promise<void> {
  const current = await loadModelSettings(home)
  if (current === undefined && profile === undefined) throw new Error('Choose a Default first.')
  const base = effectiveModelProfile(profile ?? current!, 'planner')
  const next: ModelHostProfile = target === 'all' || current === undefined
    ? { ...base, selectionVersion: 1, overrides: {} }
    : target === 'default'
      ? { ...base, selectionVersion: 1, overrides: { ...current.overrides } }
      : { ...current, overrides: { ...current.overrides } }
  if (target !== 'default' && target !== 'all') {
    if (profile === undefined) delete next.overrides![target]
    else next.overrides![target] = effectiveModelProfile(profile, target)
  }
  await upgradeManagedModelConfig(home, sharedModelPath(home))
  await saveModelHostProfile(sharedModelPath(home), next)
}

/** Commit the legacy view before creating a compatibility snapshot. */
export async function migrateModelSettings(home: string): Promise<void> {
  const shared = await optionalProfile(sharedModelPath(home))
  if (shared?.selectionVersion === 1) return
  const settings = await loadModelSettings(home)
  if (settings === undefined) return
  await saveModelHostProfile(sharedModelPath(home), settings)
}
