import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import type {
  ExamHistoryItem,
  FaceProfile,
  PublishedTest,
  ServerSettings,
  StoredResult,
  StudentRosterEntry,
  Test
} from '@test/shared'
import { TestFileStore } from './test-file-store'

type TestRow = {
  id: string
  title: string
  duration_minutes: number
  question_count: number | null
  question_order: Test['questionOrder'] | null
  show_result: number | null
  questions_json: string
  created_at: string
  updated_at: string
}

type ResultRow = {
  id: string
  session_id: string
  published_test_id: string
  test_id: string
  test_title: string
  fish: string
  student_group: string
  student_id: string | null
  identity_key: string
  device_id: string
  computer_name: string
  question_ids_json: string
  answers_json: string
  outcomes_json: string
  score: number
  total: number
  percentage: number
  started_at: string
  submitted_at: string
  duration_seconds: number
}

type ExamPublicationRow = {
  id: string
  test_id: string
  test_title: string
  duration_minutes: number
  question_count: number
  question_order: Test['questionOrder']
  show_result: number
  published_at: string
  closed_at: string | null
  status: 'open' | 'closed'
  result_count: number
}

type FaceProfileRow = {
  id: string
  fish: string
  student_group: string
  face_descriptor_json: string
  face_photo: string | null
}

const now = new Date().toISOString()
const sampleTest: Test = {
  id: 'sample_uzbekistan',
  title: "O'zbekiston haqida namunaviy test",
  durationMinutes: 10,
  questionCount: 5,
  questionOrder: 'sequential',
  showResult: true,
  createdAt: now,
  updatedAt: now,
  questions: [
    {
      id: 'q_1',
      text: "O'zbekiston Respublikasining poytaxti qaysi shahar?",
      options: ['Samarqand', 'Toshkent', 'Buxoro', 'Xiva'],
      correctIndex: 1
    },
    {
      id: 'q_2',
      text: "O'zbekiston davlat bayrog'ida nechta asosiy rang bor?",
      options: ['2 ta', '3 ta', '4 ta', '5 ta'],
      correctIndex: 2
    },
    {
      id: 'q_3',
      text: "Amir Temur qaysi shaharda tug'ilgan?",
      options: ['Shahrisabz', 'Toshkent', 'Termiz', "Qo'qon"],
      correctIndex: 0
    },
    {
      id: 'q_4',
      text: "O'zbekistonning milliy valyutasi nima?",
      options: ['Tenge', 'Somoniy', "So'm", 'Manat'],
      correctIndex: 2
    },
    {
      id: 'q_5',
      text: "O'zbekiston mustaqilligi qaysi yilda e'lon qilingan?",
      options: ['1989-yil', '1990-yil', '1991-yil', '1992-yil'],
      correctIndex: 2
    }
  ]
}

export class AppDatabase {
  private readonly db: DatabaseSync

  constructor(userDataPath: string, private readonly testFiles: TestFileStore) {
    this.db = new DatabaseSync(path.join(userDataPath, 'test-server.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        question_count INTEGER,
        question_order TEXT,
        show_result INTEGER,
        questions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        published_test_id TEXT DEFAULT '',
        test_id TEXT NOT NULL,
        test_title TEXT NOT NULL,
        fish TEXT NOT NULL,
        student_group TEXT NOT NULL,
        student_id TEXT,
        identity_key TEXT DEFAULT '',
        device_id TEXT NOT NULL,
        computer_name TEXT DEFAULT '',
        question_ids_json TEXT DEFAULT '[]',
        answers_json TEXT NOT NULL,
        outcomes_json TEXT DEFAULT '[]',
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        percentage REAL NOT NULL,
        started_at TEXT DEFAULT '',
        submitted_at TEXT NOT NULL,
        duration_seconds INTEGER DEFAULT 0,
        UNIQUE(session_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS roster (
        id TEXT PRIMARY KEY,
        fish TEXT NOT NULL,
        student_group TEXT NOT NULL,
        face_descriptor_json TEXT,
        face_photo TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exam_publications (
        id TEXT PRIMARY KEY,
        test_id TEXT NOT NULL,
        test_title TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        question_count INTEGER NOT NULL,
        question_order TEXT NOT NULL,
        show_result INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        closed_at TEXT,
        status TEXT NOT NULL
      );
      INSERT OR IGNORE INTO exam_publications (
        id, test_id, test_title, duration_minutes, question_count, question_order,
        show_result, published_at, closed_at, status
      )
      SELECT
        published_test_id,
        test_id,
        test_title,
        0,
        MAX(total),
        'sequential',
        0,
        MIN(CASE WHEN started_at = '' THEN submitted_at ELSE started_at END),
        MAX(submitted_at),
        'closed'
      FROM results
      WHERE published_test_id <> ''
      GROUP BY published_test_id, test_id, test_title;
    `)

    this.ensureColumn('tests', 'question_count', 'INTEGER')
    this.ensureColumn('tests', 'question_order', "TEXT DEFAULT 'sequential'")
    this.ensureColumn('tests', 'show_result', 'INTEGER DEFAULT 0')
    this.ensureColumn('results', 'published_test_id', "TEXT DEFAULT ''")
    this.ensureColumn('results', 'student_id', 'TEXT')
    this.ensureColumn('results', 'identity_key', "TEXT DEFAULT ''")
    this.ensureColumn('results', 'computer_name', "TEXT DEFAULT ''")
    this.ensureColumn('results', 'question_ids_json', "TEXT DEFAULT '[]'")
    this.ensureColumn('results', 'outcomes_json', "TEXT DEFAULT '[]'")
    this.ensureColumn('results', 'started_at', "TEXT DEFAULT ''")
    this.ensureColumn('results', 'duration_seconds', 'INTEGER DEFAULT 0')
    this.ensureColumn('roster', 'face_descriptor_json', 'TEXT')
    this.ensureColumn('roster', 'face_photo', 'TEXT')

    const count = this.db.prepare('SELECT COUNT(*) AS count FROM tests').get() as { count: number }
    if (count.count === 0) this.saveTest(sampleTest)
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES ('identityMode', 'manual')
      ON CONFLICT(key) DO NOTHING
    `).run()
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES ('accessMode', 'open')
      ON CONFLICT(key) DO NOTHING
    `).run()
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES ('allowedIps', '[]')
      ON CONFLICT(key) DO NOTHING
    `).run()
    this.synchronizeTestFiles()
  }

  listTests(): Test[] {
    const rows = this.db.prepare('SELECT * FROM tests ORDER BY updated_at DESC').all() as TestRow[]
    return rows.map((row) => this.mapTest(row))
  }

  getTest(id: string): Test | null {
    const row = this.db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as TestRow | undefined
    return row ? this.mapTest(row) : null
  }

  saveTest(test: Test): void {
    this.saveTestToDatabase(test)
    this.testFiles.saveTest(test)
  }

  private saveTestToDatabase(test: Test): void {
    this.db.prepare(`
      INSERT INTO tests (
        id, title, duration_minutes, question_count, question_order, show_result,
        questions_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        duration_minutes = excluded.duration_minutes,
        question_count = excluded.question_count,
        question_order = excluded.question_order,
        show_result = excluded.show_result,
        questions_json = excluded.questions_json,
        updated_at = excluded.updated_at
    `).run(
      test.id,
      test.title,
      test.durationMinutes,
      test.questionCount,
      test.questionOrder,
      test.showResult ? 1 : 0,
      JSON.stringify(test.questions),
      test.createdAt,
      test.updatedAt
    )
  }

  deleteTest(id: string): void {
    this.db.prepare('DELETE FROM tests WHERE id = ?').run(id)
    this.testFiles.deleteTest(id)
  }

  getTestsDirectory(): string {
    return this.testFiles.getDirectory()
  }

  getSettings(): ServerSettings {
    const getValue = (key: string): string | undefined =>
      (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
    const identityModeValue = getValue('identityMode')
    const accessModeValue = getValue('accessMode')
    let allowedIps: string[] = []
    try {
      const parsed = JSON.parse(getValue('allowedIps') || '[]') as unknown
      if (Array.isArray(parsed)) allowedIps = parsed.map(String).filter(Boolean)
    } catch {
      allowedIps = []
    }
    return {
      identityMode: identityModeValue === 'face' ? 'face' : identityModeValue === 'roster' ? 'roster' : 'manual',
      accessMode: accessModeValue === 'restricted' ? 'restricted' : 'open',
      allowedIps
    }
  }

  saveSettings(settings: Partial<ServerSettings>): ServerSettings {
    const current = this.getSettings()
    const next: ServerSettings = {
      identityMode: settings.identityMode === undefined
        ? current.identityMode
        : settings.identityMode === 'face' ? 'face' : settings.identityMode === 'roster' ? 'roster' : 'manual',
      accessMode: settings.accessMode === undefined ? current.accessMode : settings.accessMode === 'restricted' ? 'restricted' : 'open',
      allowedIps: settings.allowedIps === undefined ? current.allowedIps : settings.allowedIps
    }
    const saveValue = (key: string, value: string): void => {
      this.db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value)
    }
    saveValue('identityMode', next.identityMode)
    saveValue('accessMode', next.accessMode)
    saveValue('allowedIps', JSON.stringify(next.allowedIps))
    return next
  }

  getFaceDataDirectory(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'faceDataDirectory'").get() as { value: string } | undefined
    return row?.value ?? ''
  }

  saveFaceDataDirectory(directory: string): string {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES ('faceDataDirectory', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(directory)
    return directory
  }

  listRoster(): StudentRosterEntry[] {
    return this.db.prepare(`
      SELECT id, fish, student_group AS "group"
      FROM roster ORDER BY student_group, fish
    `).all() as StudentRosterEntry[]
  }

  replaceRoster(entries: StudentRosterEntry[]): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM roster').run()
      const insert = this.db.prepare('INSERT INTO roster (id, fish, student_group) VALUES (?, ?, ?)')
      for (const entry of entries) insert.run(entry.id, entry.fish, entry.group)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listFaceProfiles(): FaceProfile[] {
    const rows = this.db.prepare(`
      SELECT id, fish, student_group, face_descriptor_json, face_photo
      FROM roster
      WHERE face_descriptor_json IS NOT NULL AND face_descriptor_json <> ''
      ORDER BY student_group, fish
    `).all() as FaceProfileRow[]
    return rows.flatMap((row) => {
      const descriptor = this.parseJson<number[]>(row.face_descriptor_json, [])
      return descriptor.length ? [{
        id: row.id,
        fish: row.fish,
        group: row.student_group,
        descriptor,
        photoDataUrl: row.face_photo ?? undefined
      }] : []
    })
  }

  replaceFaceProfiles(profiles: FaceProfile[]): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM roster').run()
      const insert = this.db.prepare(`
        INSERT INTO roster (
          id, fish, student_group, face_descriptor_json, face_photo
        ) VALUES (?, ?, ?, ?, ?)
      `)
      for (const profile of profiles) {
        insert.run(
          profile.id,
          profile.fish,
          profile.group,
          JSON.stringify(profile.descriptor),
          profile.photoDataUrl ?? null
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertFaceProfile(profile: FaceProfile): void {
    this.db.prepare(`
      INSERT INTO roster (
        id, fish, student_group, face_descriptor_json, face_photo
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        fish = excluded.fish,
        student_group = excluded.student_group,
        face_descriptor_json = excluded.face_descriptor_json,
        face_photo = excluded.face_photo
    `).run(
      profile.id,
      profile.fish,
      profile.group,
      JSON.stringify(profile.descriptor),
      profile.photoDataUrl ?? null
    )
  }

  clearStoredFaceData(): void {
    this.db.prepare(`
      UPDATE roster
      SET face_descriptor_json = NULL, face_photo = NULL
      WHERE face_descriptor_json IS NOT NULL OR face_photo IS NOT NULL
    `).run()
  }

  hasPublishedResult(publishedTestId: string, identityKey: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS found FROM results
      WHERE published_test_id = ? AND identity_key = ?
      LIMIT 1
    `).get(publishedTestId, identityKey) as { found: number } | undefined
    return Boolean(row)
  }

  saveResult(result: StoredResult, identityKey: string): void {
    this.db.prepare(`
      INSERT INTO results (
        id, session_id, published_test_id, test_id, test_title, fish, student_group,
        student_id, identity_key, device_id, computer_name, question_ids_json,
        answers_json, outcomes_json, score, total, percentage, started_at,
        submitted_at, duration_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, device_id) DO UPDATE SET
        answers_json = excluded.answers_json,
        outcomes_json = excluded.outcomes_json,
        score = excluded.score,
        total = excluded.total,
        percentage = excluded.percentage,
        submitted_at = excluded.submitted_at,
        duration_seconds = excluded.duration_seconds
    `).run(
      result.id,
      result.sessionId,
      result.publishedTestId,
      result.testId,
      result.testTitle,
      result.fish,
      result.group,
      result.studentId ?? null,
      identityKey,
      result.deviceId,
      result.computerName,
      JSON.stringify(result.questionIds),
      JSON.stringify(result.answers),
      JSON.stringify(result.answerOutcomes),
      result.score,
      result.total,
      result.percentage,
      result.startedAt,
      result.submittedAt,
      result.durationSeconds
    )
  }

  saveExamPublication(published: PublishedTest): void {
    this.db.prepare(`
      INSERT INTO exam_publications (
        id, test_id, test_title, duration_minutes, question_count, question_order,
        show_result, published_at, closed_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open')
      ON CONFLICT(id) DO UPDATE SET
        test_id = excluded.test_id,
        test_title = excluded.test_title,
        duration_minutes = excluded.duration_minutes,
        question_count = excluded.question_count,
        question_order = excluded.question_order,
        show_result = excluded.show_result,
        published_at = excluded.published_at,
        closed_at = NULL,
        status = 'open'
    `).run(
      published.id,
      published.testId,
      published.title,
      published.durationMinutes,
      published.questionCount,
      published.questionOrder,
      published.showResult ? 1 : 0,
      published.publishedAt
    )
  }

  closeExamPublication(id: string, closedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE exam_publications
      SET status = 'closed', closed_at = ?
      WHERE id = ?
    `).run(closedAt, id)
  }

  closeOpenExamPublications(closedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE exam_publications
      SET status = 'closed', closed_at = ?
      WHERE status = 'open'
    `).run(closedAt)
  }

  listExamHistory(): ExamHistoryItem[] {
    const rows = this.db.prepare(`
      SELECT
        exam_publications.*,
        COUNT(results.id) AS result_count
      FROM exam_publications
      LEFT JOIN results ON results.published_test_id = exam_publications.id
      GROUP BY exam_publications.id
      ORDER BY exam_publications.published_at DESC
    `).all() as ExamPublicationRow[]

    return rows.map((row) => ({
      id: row.id,
      testId: row.test_id,
      testTitle: row.test_title,
      durationMinutes: row.duration_minutes,
      questionCount: row.question_count,
      questionOrder: row.question_order === 'random' ? 'random' : 'sequential',
      showResult: Boolean(row.show_result),
      publishedAt: row.published_at,
      closedAt: row.closed_at,
      status: row.status,
      resultCount: Number(row.result_count)
    }))
  }

  getExamHistory(id: string): ExamHistoryItem | null {
    return this.listExamHistory().find((exam) => exam.id === id) ?? null
  }

  clearSessionData(): void {
    this.db.exec(`
      DELETE FROM results;
      DELETE FROM exam_publications;
    `)
  }

  listResults(): StoredResult[] {
    const rows = this.db.prepare('SELECT * FROM results ORDER BY submitted_at DESC').all() as ResultRow[]
    return rows.map((row) => this.mapResult(row))
  }

  listResultsByPublishedTest(publishedTestId: string): StoredResult[] {
    const rows = this.db.prepare(`
      SELECT * FROM results
      WHERE published_test_id = ?
      ORDER BY submitted_at ASC
    `).all(publishedTestId) as ResultRow[]
    return rows.map((row) => this.mapResult(row))
  }

  private mapResult(row: ResultRow): StoredResult {
    return {
      id: row.id,
      sessionId: row.session_id,
      publishedTestId: row.published_test_id,
      testId: row.test_id,
      testTitle: row.test_title,
      fish: row.fish,
      group: row.student_group,
      studentId: row.student_id ?? undefined,
      deviceId: row.device_id,
      computerName: row.computer_name,
      questionIds: this.parseJson<string[]>(row.question_ids_json, []),
      answers: this.parseJson<Record<string, number>>(row.answers_json, {}),
      answerOutcomes: this.parseJson<StoredResult['answerOutcomes']>(row.outcomes_json, []),
      score: row.score,
      total: row.total,
      percentage: row.percentage,
      startedAt: row.started_at || row.submitted_at,
      submittedAt: row.submitted_at,
      durationSeconds: row.duration_seconds,
      synced: true
    }
  }

  close(): void {
    this.db.close()
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private synchronizeTestFiles(): void {
    for (const fileTest of this.testFiles.loadTests()) {
      const storedTest = this.getTest(fileTest.id)
      if (!storedTest || new Date(fileTest.updatedAt).getTime() > new Date(storedTest.updatedAt).getTime()) {
        this.saveTestToDatabase(fileTest)
      }
    }
    for (const test of this.listTests()) this.testFiles.saveTest(test)
  }

  private parseJson<T>(value: string | null | undefined, fallback: T): T {
    try {
      return value ? JSON.parse(value) as T : fallback
    } catch {
      return fallback
    }
  }

  private mapTest(row: TestRow): Test {
    const questions = this.parseJson<Test['questions']>(row.questions_json, [])
    return {
      id: row.id,
      title: row.title,
      durationMinutes: row.duration_minutes,
      questionCount: Math.min(Math.max(1, row.question_count ?? questions.length), questions.length),
      questionOrder: row.question_order === 'random' ? 'random' : 'sequential',
      showResult: Boolean(row.show_result),
      questions,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
