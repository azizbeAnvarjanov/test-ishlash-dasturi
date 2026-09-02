import fs from 'node:fs'
import path from 'node:path'
import type { Question, Test } from '@test/shared'

type TestFile = {
  format: 'test-ishlash-dasturi-test'
  version: 1
  savedAt: string
  test: Test
}

const README_FILE_NAME = 'README - Testlar.txt'

const safeFileName = (value: string): string =>
  value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 90) || 'Test'

const normalizeQuestion = (value: unknown): Question | null => {
  const item = value as Partial<Question> | null
  if (!item || typeof item !== 'object') return null
  const text = String(item.text ?? '').trim()
  const options = Array.isArray(item.options) ? item.options.map((option) => String(option ?? '').trim()) : []
  const correctIndex = Number(item.correctIndex)
  if (!item.id || !text || options.length !== 4 || options.some((option) => !option) ||
      !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
    return null
  }
  return {
    id: String(item.id),
    text,
    options: options as [string, string, string, string],
    correctIndex
  }
}

const normalizeTest = (value: unknown): Test | null => {
  const item = value as Partial<Test> | null
  if (!item || typeof item !== 'object') return null
  const questions = Array.isArray(item.questions) ? item.questions.map(normalizeQuestion) : []
  if (!item.id || !String(item.title ?? '').trim() || !questions.length || questions.some((question) => !question)) {
    return null
  }
  const validQuestions = questions as Question[]
  const durationMinutes = Math.max(1, Number(item.durationMinutes) || 20)
  const questionCount = Math.min(
    Math.max(1, Number(item.questionCount) || validQuestions.length),
    validQuestions.length
  )
  const now = new Date().toISOString()
  return {
    id: String(item.id),
    title: String(item.title).trim(),
    durationMinutes,
    questionCount,
    questionOrder: item.questionOrder === 'random' ? 'random' : 'sequential',
    showResult: Boolean(item.showResult),
    questions: validQuestions,
    createdAt: String(item.createdAt || now),
    updatedAt: String(item.updatedAt || now)
  }
}

export class TestFileStore {
  constructor(private readonly directory: string) {}

  getDirectory(): string {
    return this.directory
  }

  loadTests(): Test[] {
    this.ensureDirectory()
    const tests: Test[] = []
    for (const fileName of fs.readdirSync(this.directory)) {
      if (!fileName.toLocaleLowerCase('en-US').endsWith('.test.json')) continue
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.directory, fileName), 'utf8')) as Partial<TestFile> | Test
        const test = normalizeTest('test' in raw ? raw.test : raw)
        if (test) tests.push(test)
      } catch {
        // Bitta buzilgan fayl qolgan testlarni yuklashga xalaqit bermaydi.
      }
    }
    return tests
  }

  saveTest(test: Test): string {
    this.ensureDirectory()
    this.removeTestFiles(test.id)
    const fileName = `${safeFileName(test.title)} - ${safeFileName(test.id)}.test.json`
    const filePath = path.join(this.directory, fileName)
    const temporaryPath = `${filePath}.tmp`
    const payload: TestFile = {
      format: 'test-ishlash-dasturi-test',
      version: 1,
      savedAt: new Date().toISOString(),
      test
    }
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(temporaryPath, filePath)
    return filePath
  }

  deleteTest(id: string): void {
    this.ensureDirectory()
    this.removeTestFiles(id)
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true })
    const readmePath = path.join(this.directory, README_FILE_NAME)
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, [
        'Bu papkada Test Server V6 da yaratilgan testlarning lokal nusxalari saqlanadi.',
        'Har bir test alohida .test.json fayl ko‘rinishida yoziladi.',
        'Test Server qayta ochilganda shu fayllardagi testlarni ham tiklaydi.',
        'Fayllarni zaxiralab turish mumkin, lekin dastur ishlayotgan paytda qo‘lda o‘zgartirmang.'
      ].join('\r\n'), 'utf8')
    }
  }

  private removeTestFiles(id: string): void {
    const suffix = ` - ${safeFileName(id)}.test.json`.toLocaleLowerCase('en-US')
    for (const fileName of fs.readdirSync(this.directory)) {
      if (!fileName.toLocaleLowerCase('en-US').endsWith(suffix)) continue
      fs.rmSync(path.join(this.directory, fileName))
    }
  }
}
