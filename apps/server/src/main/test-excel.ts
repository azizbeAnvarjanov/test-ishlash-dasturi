import * as XLSX from 'xlsx'
import { createId, type Test } from '@test/shared'

type ParsedTest = {
  test: Test
  warning?: string
}

const aliases = {
  title: ['Test nomi', 'Test', 'Test nomi/title', 'Title'],
  duration: ['Vaqt (daqiqa)', 'Vaqt', 'Daqiqa', 'Duration'],
  questionCount: ['Studentga savol soni', 'Savol soni', 'Testdagi savol soni'],
  order: ['Tartib', 'Savollar tartibi'],
  showResult: ["Natijani ko'rsatish", 'Natijani ko‘rsatish', 'Natija ko‘rsatish'],
  question: ['Savol', 'Savol matni', 'Savol nomi', 'Question'],
  correct: ["To'g'ri javob", 'To‘g‘ri javob', 'Togri javob', 'Javob', 'Correct answer'],
  options: [
    ['A', 'A variant', 'Variant A', 'A javob', 'Javob A'],
    ['B', 'B variant', 'Variant B', 'B javob', 'Javob B'],
    ['C', 'C variant', 'Variant C', 'C javob', 'Javob C'],
    ['D', 'D variant', 'Variant D', 'D javob', 'Javob D']
  ]
}

const normalize = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('uz-UZ')
    .replace(/[ʻʼ‘’`´']/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^a-z0-9\u0400-\u04ff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const text = (value: unknown): string => String(value ?? '').trim()

const findColumn = (headers: unknown[], names: string[]): number => {
  const normalizedNames = names.map(normalize)
  return headers.findIndex((header) => normalizedNames.includes(normalize(header)))
}

const cell = (headers: unknown[], row: unknown[], names: string[]): string => {
  const column = findColumn(headers, names)
  return column >= 0 ? text(row[column]) : ''
}

const headerScore = (row: unknown[]): number => {
  let score = 0
  if (findColumn(row, aliases.question) >= 0) score += 3
  if (findColumn(row, aliases.correct) >= 0) score += 3
  for (const optionAliases of aliases.options) {
    if (findColumn(row, optionAliases) >= 0) score += 1
  }
  if (findColumn(row, aliases.title) >= 0) score += 1
  return score
}

const parseCorrectIndex = (value: string, options: string[]): number => {
  const normalized = normalize(value)
  const letter = normalized.match(/^(?:variant\s*)?([abcd])(?:\s*variant)?$/i)?.[1]?.toUpperCase()
  if (letter) return ['A', 'B', 'C', 'D'].indexOf(letter)
  if (/^[1-4]$/.test(normalized)) return Number(normalized) - 1
  return options.findIndex((option) => normalize(option) === normalized)
}

export const parseTestWorkbook = (workbook: XLSX.WorkBook): ParsedTest => {
  let best: { sheetName: string; rows: unknown[][]; headerIndex: number; score: number } | null = null
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false
    })
    const headerLimit = Math.min(rows.length, 25)
    for (let headerIndex = 0; headerIndex < headerLimit; headerIndex += 1) {
      const row = rows[headerIndex]
      const score = headerScore(row)
      if (!best || score > best.score) best = { sheetName, rows, headerIndex, score }
    }
  }

  if (!best || best.score < 7) {
    throw new Error("Excel sarlavhalari topilmadi. Kamida Savol, A, B, C, D va To'g'ri javob ustunlari bo‘lishi kerak")
  }

  const selectedSheet = best
  const headers = selectedSheet.rows[selectedSheet.headerIndex]
  const dataRows = selectedSheet.rows.slice(selectedSheet.headerIndex + 1)
  const firstMetadataRow = dataRows.find((row) =>
    Boolean(cell(headers, row, aliases.title) || cell(headers, row, aliases.duration))
  ) ?? dataRows[0] ?? []
  const title = cell(headers, firstMetadataRow, aliases.title)
  if (!title) throw new Error("'Test nomi' ustunida test nomi yozilmagan")

  const questions: Test['questions'] = []
  const skipped: string[] = []
  dataRows.forEach((row, index) => {
    const questionText = cell(headers, row, aliases.question)
    const options = aliases.options.map((optionAliases) => cell(headers, row, optionAliases))
    const correctText = cell(headers, row, aliases.correct)
    if (!questionText && options.every((option) => !option) && !correctText) return
    const excelRow = selectedSheet.headerIndex + index + 2
    if (!questionText) {
      skipped.push(`${excelRow}-qator: savol matni yo‘q`)
      return
    }
    if (options.some((option) => !option)) {
      skipped.push(`${excelRow}-qator: A, B, C yoki D variant to‘liq emas`)
      return
    }
    const correctIndex = parseCorrectIndex(correctText, options)
    if (correctIndex < 0) {
      skipped.push(`${excelRow}-qator: to‘g‘ri javob A-D, 1-4 yoki variant matni bo‘lishi kerak`)
      return
    }
    questions.push({
      id: createId('q'),
      text: questionText,
      options: options as [string, string, string, string],
      correctIndex
    })
  })

  if (!questions.length) {
    throw new Error(skipped[0] || 'Excelda import qilinadigan savol topilmadi')
  }

  const durationMinutes = Math.max(1, Number(cell(headers, firstMetadataRow, aliases.duration).replace(',', '.')) || 20)
  const requestedCount = Number(cell(headers, firstMetadataRow, aliases.questionCount).replace(',', '.'))
  const order = normalize(cell(headers, firstMetadataRow, aliases.order))
  const show = normalize(cell(headers, firstMetadataRow, aliases.showResult))
  const timestamp = new Date().toISOString()
  return {
    test: {
      id: '',
      title,
      durationMinutes,
      questionCount: Math.min(Math.max(1, requestedCount || questions.length), questions.length),
      questionOrder: ['random', 'tasodifiy', 'aralash'].includes(order) ? 'random' : 'sequential',
      showResult: ['ha', 'yes', '1', 'true', 'kursatish', 'korsatish'].includes(show),
      questions,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    warning: skipped.length
      ? `${skipped.length} ta qator o‘tkazib yuborildi: ${skipped.slice(0, 3).join('; ')}`
      : undefined
  }
}
