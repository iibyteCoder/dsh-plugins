/**
 * Text formatting helpers shared by the read tools.
 */

/**
 * Truncate text to at most `maxChars` Unicode code points, appending `…`
 * when characters were dropped.
 */
export function truncateText(text: unknown, maxChars: number): string {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  const chars = Array.from(value)
  if (chars.length <= maxChars) return value
  return `${chars.slice(0, maxChars).join('')}…`
}

/**
 * Format a timestamp as local-time `YYYY-MM-DD HH:mm`.
 *
 * Accepts epoch milliseconds, Date instances, and parseable date strings.
 * Returns `-` for missing or invalid values.
 */
export function formatTime(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  const date = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Render a two-dimensional array as an aligned plain-text table.
 *
 * The first row is treated as the header; a dashed separator follows it.
 * Missing cells are rendered as empty strings.
 */
export function formatTable(rows: unknown): string {
  const source = Array.isArray(rows) ? rows : []
  const matrix = source.map((row: unknown) =>
    (Array.isArray(row) ? row : [row]).map((cell: unknown) => String(cell ?? '')),
  )
  if (matrix.length === 0) return ''

  const columns = Math.max(...matrix.map((row) => row.length))
  const widths: number[] = []
  for (let column = 0; column < columns; column += 1) {
    widths[column] = Math.max(...matrix.map((row) => displayWidth(row[column] ?? '')))
  }

  const renderRow = (row: readonly string[]): string =>
    widths
      .map((width, column) => {
        const cell = row[column] ?? ''
        const padding = Math.max(0, width - displayWidth(cell))
        return `${cell}${' '.repeat(padding)}`
      })
      .join('  ')
      .trimEnd()

  const [header = [], ...body] = matrix
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  return [renderRow(header), separator, ...body.map(renderRow)].join('\n')
}

/**
 * Terminal display width of a string, counting East Asian wide characters
 * and emoji as two columns. Enough for the CJK text this plugin prints.
 */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1
  }
  return width
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}
