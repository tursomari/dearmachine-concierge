import {
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui'
import type { InstallerTheme } from './theme.ts'

export interface InstallerChoice {
  value: string
  label: string
  description?: string
}

/** Searchable keyboard selector used by the pre-agent setup wizard. */
export class ChoiceInput implements Component, Focusable {
  private readonly filter = new Input()
  private list: SelectList
  private readonly items: readonly InstallerChoice[]
  private readonly selectTheme: SelectListTheme
  onSubmit?: (choice: InstallerChoice) => void
  onBack?: () => void

  constructor(
    items: readonly InstallerChoice[],
    selectedValue: string | undefined,
    private readonly maxVisible: number,
    private readonly theme: InstallerTheme,
  ) {
    this.items = items
    this.selectTheme = {
      selectedPrefix: theme.truth,
      selectedText: theme.truth,
      description: theme.dim,
      scrollInfo: theme.dim,
      noMatch: theme.provenance,
    }
    this.list = this.buildList(selectedValue)
  }

  get focused(): boolean { return this.filter.focused }
  set focused(value: boolean) { this.filter.focused = value }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
      this.list.handleInput(data)
    } else if (matchesKey(data, Key.escape)) {
      if (this.filter.getValue() === '') {
        this.onBack?.()
        return
      }
      this.filter.setValue('')
      this.list = this.buildList(undefined)
    } else {
      const previous = this.filter.getValue()
      this.filter.handleInput(data)
      if (this.filter.getValue() !== previous) {
        this.list = this.buildList(this.list.getSelectedItem()?.value)
      }
    }
    this.invalidate()
  }

  invalidate(): void {
    this.filter.invalidate()
    this.list.invalidate()
  }

  render(width: number): string[] {
    const prefix = this.theme.dim('Filter: ')
    const inputWidth = Math.max(1, width - visibleWidth(prefix))
    const filter = truncateToWidth(this.filter.render(inputWidth).join(''), inputWidth, '')
    const help = truncateToWidth('type to filter • ↑/↓ move • Enter select • Esc clear/back', width, '…')
    return [
      `${prefix}${filter}`,
      '',
      ...this.list.render(width),
      '',
      this.theme.dim(help),
    ]
  }

  private filtered(): InstallerChoice[] {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    if (query === '') return [...this.items]
    return this.items.filter(item => [item.label, item.value, item.description ?? '']
      .some(value => value.toLocaleLowerCase().includes(query)))
  }

  private buildList(selectedValue: string | undefined): SelectList {
    const choices = this.filtered()
    const items: SelectItem[] = choices.map(choice => ({
      value: choice.value,
      label: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    }))
    // Let the primary column grow to the widest visible label. SelectList
    // still clamps it to the current viewport and drops the description first
    // when a narrow terminal cannot show both columns.
    const list = new SelectList(items, this.maxVisible, this.selectTheme, {
      minPrimaryColumnWidth: 16,
      maxPrimaryColumnWidth: 72,
    })
    const index = selectedValue === undefined ? 0 : items.findIndex(item => item.value === selectedValue)
    list.setSelectedIndex(Math.max(0, index))
    list.onSelect = item => {
      const selected = choices.find(choice => choice.value === item.value)
      if (selected !== undefined) this.onSubmit?.(selected)
    }
    return list
  }
}
