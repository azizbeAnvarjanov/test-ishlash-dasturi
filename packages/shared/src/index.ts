export type Question = {
  id: string
  text: string
  options: string[]
  correctIndex: number
}

export type Test = {
  id: string
  title: string
  durationMinutes: number
  questionCount: number
  questionOrder: 'sequential' | 'random'
  showResult: boolean
  questions: Question[]
  createdAt: string
  updatedAt: string
}

export type PublishedTest = {
  id: string
  testId: string
  title: string
  durationMinutes: number
  questionCount: number
  questionOrder: Test['questionOrder']
  showResult: boolean
  publishedAt: string
}

export type ServerSettings = {
  identityMode: 'manual' | 'roster' | 'face'
  accessMode: 'open' | 'restricted'
  allowedIps: string[]
}

export type StudentRosterEntry = {
  id: string
  fish: string
  group: string
}

export type StudentIdentity = {
  fish: string
  group: string
  studentId?: string
  deviceId: string
  computerName: string
}

export type ConnectedStudent = StudentIdentity & {
  id?: string
  status: 'connected' | 'working' | 'completed'
  sessionId?: string
  testTitle?: string
  currentQuestion?: number
  answeredCount?: number
  totalQuestions?: number
  startedAt?: string
  heartbeatAt?: string
  connectedAt: string
  online: boolean
}

export type ExamSession = {
  id: string
  publishedTestId: string
  testId: string
  test: Test
  startedAt: string
  endsAt: string
  status: 'active' | 'completed' | 'stopped'
}

export type StudentSubmission = {
  id: string
  sessionId: string
  publishedTestId: string
  testId: string
  fish: string
  group: string
  studentId?: string
  deviceId: string
  computerName: string
  questionIds: string[]
  answers: Record<string, number>
  startedAt: string
  submittedAt: string
  durationSeconds: number
}

export type AnswerOutcome = {
  questionId: string
  questionText: string
  selectedIndex: number | null
  selectedAnswer: string | null
  correctIndex: number
  correctAnswer: string
  isCorrect: boolean
}

export type StoredResult = StudentSubmission & {
  testTitle: string
  score: number
  total: number
  percentage: number
  answerOutcomes: AnswerOutcome[]
  synced: boolean
}

export type ResultReceipt = {
  ok: boolean
  resultId: string
  showResult: boolean
  score?: number
  total?: number
  percentage?: number
}

export type BootstrapData = {
  settings: ServerSettings
  roster: StudentRosterEntry[]
  tests: PublishedTest[]
}

export type FaceProfile = StudentRosterEntry & {
  descriptor: number[]
  photoDataUrl?: string
}

export type FaceRecognitionResponse =
  | { matched: true; student: StudentRosterEntry; similarity: number }
  | { matched: false; similarity: number }

export type FaceEnrollmentRequest = {
  id: string
  deviceId: string
  computerName: string
  descriptor?: number[]
  photoDataUrl?: string
  requestedAt: string
  status: 'pending' | 'scan_requested' | 'scanned' | 'approved' | 'rejected'
  student?: StudentRosterEntry
  message?: string
}

export type FaceEnrollmentStatus = Pick<FaceEnrollmentRequest, 'id' | 'status' | 'requestedAt' | 'student' | 'message'>

export type ExamHistoryItem = {
  id: string
  testId: string
  testTitle: string
  durationMinutes: number
  questionCount: number
  questionOrder: Test['questionOrder']
  showResult: boolean
  publishedAt: string
  closedAt: string | null
  status: 'open' | 'closed'
  resultCount: number
}

export type ResultsArchive = {
  format: 'test-ishlash-dasturi-results'
  version: number
  sessionId: string
  startedAt: string
  savedAt: string
  results: StoredResult[]
}

export type AppUpdateState = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'busy' | 'blocked' | 'unavailable' | 'error'
  message: string
  currentVersion: string
  availableVersion?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

export type ServerEvent =
  | { type: 'server:ready'; tests: PublishedTest[]; settings: ServerSettings }
  | { type: 'tests:changed'; tests: PublishedTest[] }
  | { type: 'students:changed' }
  | { type: 'exam:stopped'; sessionId: string; message?: string }
  | { type: 'student:kicked'; message: string }
  | { type: 'result:received'; resultId: string }
  | { type: 'error'; message: string }

export const createId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

export const withoutAnswers = (test: Test): Test => ({
  ...test,
  questions: test.questions.map(({ correctIndex: _correctIndex, ...question }) => question)
}) as Test
