import { CURSOR_MARKER, Input, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui'

/** Single-line input whose underlying value is never returned from render(). */
export class MaskedInput implements Component, Focusable {
  private readonly input = new Input()
  onSubmit?: (value: string) => void

  constructor() {
    this.input.onSubmit = value => { this.onSubmit?.(value) }
  }

  get focused(): boolean { return this.input.focused }
  set focused(value: boolean) { this.input.focused = value }

  clear(): void { this.input.setValue('') }

  handleInput(data: string): void { this.input.handleInput(data) }

  invalidate(): void { this.input.invalidate() }

  render(width: number): string[] {
    const prompt = '› '
    const available = width - visibleWidth(prompt)
    if (available <= 0) return [prompt]
    const count = [...this.input.getValue()].length
    const maskWidth = Math.max(0, available - 1)
    const mask = count <= maskWidth
      ? '•'.repeat(count)
      : maskWidth === 0 ? '' : `…${'•'.repeat(maskWidth - 1)}`
    const marker = this.focused ? CURSOR_MARKER : ''
    const cursor = '\u001b[7m \u001b[27m'
    const padding = ' '.repeat(Math.max(0, available - visibleWidth(mask) - 1))
    return [`${prompt}${mask}${marker}${cursor}${padding}`]
  }
}
