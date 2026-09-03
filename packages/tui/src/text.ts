const CONTROL_PICTURE_BASE = 0x2400

export function displayText(value: string): string {
  return Array.from(value, character => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7f) return '\u2421'
    if (code < 0x20 && character !== '\n' && character !== '\t') {
      return String.fromCodePoint(CONTROL_PICTURE_BASE + code)
    }
    return character
  }).join('')
}
