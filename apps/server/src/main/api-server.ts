import http from 'node:http'
import os from 'node:os'
import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createId,
  withoutAnswers,
  type ConnectedStudent,
  type ExamSession,
  type FaceEnrollmentRequest,
  type FaceEnrollmentStatus,
  type FaceProfile,
  type FaceRecognitionResponse,
  type PublishedTest,
  type ServerEvent,
  type ServerSettings,
  type StudentIdentity,
  type StudentRosterEntry,
  type StudentSubmission,
  type StoredResult,
  type Test
} from '@test/shared'
import { AppDatabase } from './database'
import { FaceProfileStore } from './face-profile-store'

type ClientMessage = {
  type: 'student:join'
  student: StudentIdentity
}

type AttemptState = {
  exam: ExamSession
  student: StudentIdentity
  identityKey: string
  answers: Record<string, number>
  currentQuestion: number
  heartbeatAt: string
}

type LanAddressCandidate = {
  address: string
  interfaceName: string
  score: number
  linkLocal: boolean
}

const lanAddressScore = (interfaceName: string, address: string): number => {
  const name = interfaceName.toLocaleLowerCase('en-US')
  let score = 0
  if (/wi-?fi|wireless|wlan|ethernet|\blan\b/.test(name)) score += 50
  if (/virtual|vmware|virtualbox|hyper-v|vethernet|wsl|docker|vpn|tailscale|zerotier|hamachi|bluetooth/.test(name)) score -= 200
  if (/^192\.168\./.test(address)) score += 40
  else if (/^10\./.test(address)) score += 35
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 30
  if (/^169\.254\./.test(address)) score -= 500
  return score
}

export const getLanIPv4Addresses = (): string[] => {
  const candidates: LanAddressCandidate[] = []
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      candidates.push({
        address: entry.address,
        interfaceName,
        score: lanAddressScore(interfaceName, entry.address),
        linkLocal: entry.address.startsWith('169.254.')
      })
    }
  }
  const usable = candidates.filter((candidate) => !candidate.linkLocal)
  return (usable.length ? usable : candidates)
    .sort((a, b) => b.score - a.score || a.interfaceName.localeCompare(b.interfaceName) || a.address.localeCompare(b.address))
    .map((candidate) => candidate.address)
}

export class TestApiServer {
  private readonly app = express()
  private readonly server = http.createServer(this.app)
  private readonly wss = new WebSocketServer({ server: this.server })
  private readonly students = new Map<WebSocket, ConnectedStudent>()
  private readonly clientIps = new Map<WebSocket, string>()
  private readonly publishedTests = new Map<string, PublishedTest>()
  private readonly sessionPublicationIds = new Set<string>()
  private readonly attempts = new Map<string, AttemptState>()
  private readonly faceEnrollmentRequests = new Map<string, FaceEnrollmentRequest>()

  constructor(
    private readonly database: AppDatabase,
    private readonly faceProfiles: FaceProfileStore,
    private readonly port = 4780,
    private readonly onResultSaved?: () => void | Promise<void>
  ) {
    this.database.closeOpenExamPublications()
    this.configureHttp()
    this.configureWebSocket()
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      // Barcha interfeysda tinglash LAN IP va serverning ichki localhost aloqasini bir vaqtda ishlatadi.
      this.server.listen(this.port, '0.0.0.0', () => resolve())
    })
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.close()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  getAddresses(): string[] {
    const addresses = new Set<string>(getLanIPv4Addresses().map((address) => `${address}:${this.port}`))
    addresses.add(`127.0.0.1:${this.port}`)
    return [...addresses]
  }

  getServerAddress(): string {
    return this.getAddresses()[0]
  }

  private configureHttp(): void {
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      if (req.method === 'OPTIONS') return res.sendStatus(204)
      next()
    })
    this.app.use((req, res, next) => {
      if (this.isLocalRequest(req.ip) || this.isIpAllowed(req.ip)) return next()
      res.status(403).json({ message: 'Bu kompyuter IP manzili serverda ruxsat etilmagan' })
    })
    this.app.use(express.json({ limit: '25mb' }))

    this.app.get('/api/health', (_req, res) => {
      res.json({
        ok: true,
        serverAddress: this.getServerAddress(),
        addresses: this.getAddresses(),
        publishedTests: this.listPublishedTests().length,
        activeAttempts: this.attempts.size
      })
    })

    this.app.get('/api/bootstrap', (_req, res) => {
      res.json({
        settings: this.database.getSettings(),
        roster: this.listCurrentRoster(),
        tests: this.listPublishedTests()
      })
    })

    this.app.get('/api/settings', (_req, res) => res.json(this.database.getSettings()))
    this.app.put('/api/settings', (req, res) => {
      if (!this.isLocalRequest(req.ip)) return res.status(403).json({ message: 'Server sozlamalarini faqat server kompyuterida o‘zgartirish mumkin' })
      const settings: Partial<ServerSettings> = {}
      if (req.body?.identityMode !== undefined) {
        settings.identityMode = req.body.identityMode === 'face' ? 'face' : req.body.identityMode === 'roster' ? 'roster' : 'manual'
      }
      if (req.body?.accessMode !== undefined) {
        settings.accessMode = req.body.accessMode === 'restricted' ? 'restricted' : 'open'
      }
      if (req.body?.allowedIps !== undefined) {
        const allowedIps = this.normalizeAllowedIps(req.body.allowedIps)
        if (!allowedIps) return res.status(400).json({ message: 'IP manzillar noto‘g‘ri. Masalan: 192.168.1.10, 192.168.1.11' })
        settings.allowedIps = allowedIps
      }
      if (settings.accessMode === 'restricted' && (settings.allowedIps ?? this.database.getSettings().allowedIps).length === 0) {
        return res.status(400).json({ message: 'Yopiq rejim uchun kamida bitta ruxsat etilgan IP yozing' })
      }
      const saved = this.database.saveSettings(settings)
      this.disconnectUnauthorizedClients()
      res.json(saved)
    })

    this.app.get('/api/roster', (_req, res) => {
      try {
        res.json(this.listCurrentRoster())
      } catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Face ID bazasini o'qib bo'lmadi" })
      }
    })
    this.app.put('/api/roster', (req, res) => {
      const entries = this.normalizeRoster(req.body)
      if (!entries) return res.status(400).json({ message: "Ro'yxat ma'lumotlari noto'g'ri" })
      this.database.replaceRoster(entries)
      res.json(entries)
    })

    this.app.get('/api/face/profiles/count', (_req, res) => {
      try {
        res.json({ count: this.faceProfiles.listProfiles().length })
      } catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Face ID bazasini o'qib bo'lmadi" })
      }
    })

    this.app.put('/api/face/profiles', (req, res) => {
      if (!Array.isArray(req.body)) return res.status(400).json({ message: "Face ID bazasi noto'g'ri" })
      const profiles = req.body.flatMap((item: Partial<FaceProfile>) => {
        const descriptor = this.normalizeDescriptor(item.descriptor)
        const fish = String(item.fish ?? '').trim()
        const group = String(item.group ?? '').trim()
        if (!descriptor || !fish || !group) return []
        return [{
          id: String(item.id || createId('student')),
          fish,
          group,
          descriptor,
          photoDataUrl: this.normalizePhoto(item.photoDataUrl)
        }]
      })
      if (!profiles.length) return res.status(400).json({ message: 'Face ID profil topilmadi' })
      try {
        const count = this.faceProfiles.replaceProfiles(profiles)
        this.database.clearStoredFaceData()
        res.json({ ok: true, count })
      } catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Face ID bazasini saqlab bo'lmadi" })
      }
    })

    this.app.delete('/api/face/profiles/:id', (req, res) => {
      try {
        const deleted = this.faceProfiles.deleteProfile(req.params.id)
        if (!deleted) return res.status(404).json({ message: 'Face ID profili topilmadi' })
        this.database.clearStoredFaceData()
        res.sendStatus(204)
      } catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Face ID profilini o'chirib bo'lmadi" })
      }
    })

    this.app.post('/api/face/recognize', (req, res) => {
      const descriptor = this.normalizeDescriptor(req.body?.descriptor)
      if (!descriptor) return res.status(400).json({ message: 'Yuz descriptori noto‘g‘ri' })
      let profiles: FaceProfile[]
      try {
        profiles = this.faceProfiles.listProfiles()
      } catch (error) {
        return res.status(500).json({ message: error instanceof Error ? error.message : "Face ID bazasini o'qib bo'lmadi" })
      }
      let best: FaceProfile | null = null
      let similarity = 0
      for (const profile of profiles) {
        if (profile.descriptor.length !== descriptor.length) continue
        const score = this.faceSimilarity(descriptor, profile.descriptor)
        if (score > similarity) {
          similarity = score
          best = profile
        }
      }
      const response: FaceRecognitionResponse = best && similarity >= 0.5
        ? {
            matched: true,
            student: { id: best.id, fish: best.fish, group: best.group },
            similarity
          }
        : { matched: false, similarity }
      res.json(response)
    })

    this.app.post('/api/face/register', (req, res) => {
      if (!this.isLocalRequest(req.ip)) return res.status(403).json({ message: 'Face ID registratsiyasi faqat server kompyuterida mumkin' })
      const descriptor = this.normalizeDescriptor(req.body?.descriptor)
      const fish = String(req.body?.fish ?? '').trim()
      const group = String(req.body?.group ?? '').trim()
      if (!descriptor || !fish || !group) {
        return res.status(400).json({ message: "F.I.Sh, guruh va yuz ma'lumoti to'liq emas" })
      }
      let storedProfiles: FaceProfile[]
      try {
        storedProfiles = this.faceProfiles.listProfiles()
      } catch (error) {
        return res.status(500).json({ message: error instanceof Error ? error.message : "Face ID bazasini o'qib bo'lmadi" })
      }
      const existing = storedProfiles.find(
        (item) => item.fish.toLocaleLowerCase('uz-UZ') === fish.toLocaleLowerCase('uz-UZ') && item.group === group
      )
      const profile: FaceProfile = {
        id: existing?.id ?? createId('student'),
        fish,
        group,
        descriptor,
        photoDataUrl: this.normalizePhoto(req.body?.photoDataUrl)
      }
      try {
        this.faceProfiles.upsertProfile(profile)
        this.database.clearStoredFaceData()
        res.status(201).json({ ok: true, student: { id: profile.id, fish, group } })
      } catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Face ID profilini saqlab bo'lmadi" })
      }
    })

    this.app.post('/api/face/enrollment-requests', (req, res) => {
      const deviceId = String(req.body?.deviceId ?? '').trim()
      const computerName = String(req.body?.computerName ?? '').trim()
      if (!deviceId || !computerName) {
        return res.status(400).json({ message: "Kompyuter ma'lumoti to'liq emas" })
      }

      for (const [id, request] of this.faceEnrollmentRequests) {
        if (request.deviceId === deviceId && !['approved', 'rejected'].includes(request.status)) {
          this.faceEnrollmentRequests.delete(id)
        }
      }
      const request: FaceEnrollmentRequest = {
        id: createId('face_request'),
        deviceId,
        computerName,
        requestedAt: new Date().toISOString(),
        status: 'pending',
        message: 'Serverda skanerlash boshlanishi kutilmoqda'
      }
      this.faceEnrollmentRequests.set(request.id, request)
      this.removeExpiredFaceEnrollmentRequests()
      res.status(201).json(this.enrollmentStatus(request))
    })

    this.app.get('/api/face/enrollment-requests', (req, res) => {
      if (!this.isLocalRequest(req.ip)) return res.status(403).json({ message: 'Bu amal faqat server kompyuterida mavjud' })
      this.removeExpiredFaceEnrollmentRequests()
      res.json([...this.faceEnrollmentRequests.values()]
        .filter((request) => !['approved', 'rejected'].includes(request.status))
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)))
    })

    this.app.get('/api/face/enrollment-requests/:id/status', (req, res) => {
      const request = this.faceEnrollmentRequests.get(req.params.id)
      if (!request) return res.status(404).json({ message: 'Registratsiya so‘rovi topilmadi yoki muddati tugagan' })
      res.json(this.enrollmentStatus(request))
    })

    this.app.post('/api/face/enrollment-requests/:id/start-scan', (req, res) => {
      if (!this.isLocalRequest(req.ip)) return res.status(403).json({ message: 'Skanerlash faqat server kompyuteridan boshlanadi' })
      const request = this.faceEnrollmentRequests.get(req.params.id)
      if (!request || request.status !== 'pending') return res.status(404).json({ message: 'Kutilayotgan registratsiya so‘rovi topilmadi' })
      request.status = 'scan_requested'
      request.message = 'Student kamerasida skanerlash boshlandi'
      res.json(this.enrollmentStatus(request))
    })

    this.app.post('/api/face/enrollment-requests/:id/capture', (req, res) => {
      const request = this.faceEnrollmentRequests.get(req.params.id)
      if (!request || request.status !== 'scan_requested') return res.status(404).json({ message: 'Skanerlash so‘rovi faol emas' })
      const deviceId = String(req.body?.deviceId ?? '').trim()
      const descriptor = this.normalizeDescriptor(req.body?.descriptor)
      const photoDataUrl = this.normalizePhoto(req.body?.photoDataUrl)
      if (deviceId !== request.deviceId || !descriptor || !photoDataUrl) {
        return res.status(400).json({ message: 'Student kamerasi yoki yuz ma’lumoti noto‘g‘ri' })
      }
      request.descriptor = descriptor
      request.photoDataUrl = photoDataUrl
      request.status = 'scanned'
      request.message = 'Yuz skanerlandi. Serverda student ma’lumotlarini kiriting'
      res.json(this.enrollmentStatus(request))
    })

    this.app.post('/api/face/enrollment-requests/:id/approve', (req, res) => {
      if (!this.isLocalRequest(req.ip)) return res.status(403).json({ message: 'Tasdiqlash faqat server kompyuterida mumkin' })
      const request = this.faceEnrollmentRequests.get(req.params.id)
      if (!request || request.status !== 'scanned' || !request.descriptor || !request.photoDataUrl) {
        return res.status(404).json({ message: 'Skanerlangan Face ID so‘rovi topilmadi' })
      }
      const firstName = String(req.body?.firstName ?? '').trim()
      const lastName = String(req.body?.lastName ?? '').trim()
      const group = String(req.body?.group ?? '').trim()
      if (!firstName || !lastName || !group) return res.status(400).json({ message: 'Ism, familiya va guruhni to‘liq kiriting' })
      const fish = `${lastName} ${firstName}`
      const profile: FaceProfile = {
        id: createId('student'),
        fish,
        group,
        descriptor: request.descriptor,
        photoDataUrl: request.photoDataUrl
      }
      try {
        this.faceProfiles.upsertProfile(profile)
        this.database.clearStoredFaceData()
        request.status = 'approved'
        request.student = { id: profile.id, fish, group }
        request.message = 'O‘qituvchi registratsiyani tasdiqladi'
        res.json(this.enrollmentStatus(request))
      } catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Face ID profilini saqlab bo'lmadi" })
      }
    })

    this.app.post('/api/face/enrollment-requests/:id/reject', (req, res) => {
      if (!this.isLocalRequest(req.ip)) return res.status(403).json({ message: 'Rad etish faqat server kompyuterida mumkin' })
      const request = this.faceEnrollmentRequests.get(req.params.id)
      if (!request || ['approved', 'rejected'].includes(request.status)) return res.status(404).json({ message: 'Faol registratsiya so‘rovi topilmadi' })
      request.status = 'rejected'
      request.message = String(req.body?.message ?? '').trim() || 'O‘qituvchi registratsiyani rad etdi'
      res.json(this.enrollmentStatus(request))
    })

    this.app.get('/api/tests', (_req, res) => res.json(this.database.listTests()))

    this.app.post('/api/tests', (req, res) => {
      const test = this.normalizeTest(req.body)
      if (!test) return res.status(400).json({ message: "Test ma'lumotlari noto'g'ri" })
      this.database.saveTest(test)
      res.status(201).json(test)
    })

    this.app.put('/api/tests/:id', (req, res) => {
      const test = this.normalizeTest({ ...req.body, id: req.params.id })
      if (!test) return res.status(400).json({ message: "Test ma'lumotlari noto'g'ri" })
      this.database.saveTest(test)
      res.json(test)
    })

    this.app.delete('/api/tests/:id', (req, res) => {
      if ([...this.publishedTests.values()].some((item) => item.testId === req.params.id)) {
        return res.status(409).json({ message: "Studentlarga yuborilgan testni o'chirib bo'lmaydi" })
      }
      this.database.deleteTest(req.params.id)
      res.sendStatus(204)
    })

    this.app.get('/api/published-tests', (_req, res) => res.json(this.listPublishedTests()))

    this.app.post('/api/published-tests', (req, res) => {
      const test = this.database.getTest(String(req.body?.testId ?? ''))
      if (!test) return res.status(404).json({ message: 'Test topilmadi' })
      const existing = [...this.publishedTests.values()].find((item) => item.testId === test.id)
      if (existing) return res.json(existing)

      const published: PublishedTest = {
        id: createId('published'),
        testId: test.id,
        title: test.title,
        durationMinutes: test.durationMinutes,
        questionCount: test.questionCount,
        questionOrder: test.questionOrder,
        showResult: test.showResult,
        publishedAt: new Date().toISOString()
      }
      this.publishedTests.set(published.id, published)
      this.sessionPublicationIds.add(published.id)
      this.database.saveExamPublication(published)
      this.broadcast({ type: 'tests:changed', tests: this.listPublishedTests() })
      res.status(201).json(published)
    })

    this.app.delete('/api/published-tests/:id', (req, res) => {
      if (!this.publishedTests.has(req.params.id)) return res.sendStatus(204)
      this.publishedTests.delete(req.params.id)
      this.database.closeExamPublication(req.params.id)
      for (const [sessionId, attempt] of this.attempts) {
        if (attempt.exam.publishedTestId !== req.params.id) continue
        this.attempts.delete(sessionId)
        this.broadcast({
          type: 'exam:stopped',
          sessionId,
          message: "Test server tomonidan to'xtatildi"
        })
        this.updateStudent(attempt.student.deviceId, {
          status: 'connected',
          sessionId: undefined,
          testTitle: undefined,
          currentQuestion: undefined,
          answeredCount: undefined,
          totalQuestions: undefined,
          startedAt: undefined
        })
      }
      this.broadcast({ type: 'tests:changed', tests: this.listPublishedTests() })
      this.broadcast({ type: 'students:changed' })
      res.sendStatus(204)
    })

    this.app.post('/api/published-tests/:id/start', (req, res) => {
      const published = this.publishedTests.get(req.params.id)
      if (!published) return res.status(404).json({ message: 'Bu test endi mavjud emas' })
      const student = this.normalizeIdentity(req.body?.student)
      if (!student) return res.status(400).json({ message: "Student ma'lumotlari to'liq emas" })
      if (!this.identityAllowed(student)) {
        return res.status(403).json({ message: "Student server ro'yxatidan topilmadi" })
      }

      const identityKey = this.identityKey(student)
      if (this.database.hasPublishedResult(published.id, identityKey)) {
        return res.status(409).json({ message: 'Bu student ushbu testni avval ishlab bo‘lgan' })
      }
      const duplicate = [...this.attempts.values()].find(
        (item) => item.exam.publishedTestId === published.id && item.identityKey === identityKey
      )
      if (duplicate) {
        if (duplicate.student.deviceId === student.deviceId) return res.json(duplicate.exam)
        return res.status(409).json({
          message: 'Bu student testni boshqa kompyuterda ishlayapti. Dubl urinish bloklandi.'
        })
      }

      const test = this.database.getTest(published.testId)
      if (!test) return res.status(404).json({ message: 'Test topilmadi' })
      const selectedQuestions = this.selectQuestions(test)
      const startedAt = new Date()
      const exam: ExamSession = {
        id: createId('session'),
        publishedTestId: published.id,
        testId: test.id,
        test: withoutAnswers({ ...test, questionCount: selectedQuestions.length, questions: selectedQuestions }),
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + test.durationMinutes * 60_000).toISOString(),
        status: 'active'
      }
      this.attempts.set(exam.id, {
        exam,
        student,
        identityKey,
        answers: {},
        currentQuestion: 1,
        heartbeatAt: startedAt.toISOString()
      })
      this.updateStudent(student.deviceId, {
        ...student,
        status: 'working',
        sessionId: exam.id,
        testTitle: test.title,
        currentQuestion: 1,
        answeredCount: 0,
        totalQuestions: selectedQuestions.length,
        startedAt: exam.startedAt,
        heartbeatAt: exam.startedAt
      })
      this.broadcast({ type: 'students:changed' })
      res.status(201).json(exam)
    })

    this.app.post('/api/exam/progress', (req, res) => {
      const sessionId = String(req.body?.sessionId ?? '')
      const deviceId = String(req.body?.deviceId ?? '')
      const attempt = this.attempts.get(sessionId)
      if (!attempt || attempt.student.deviceId !== deviceId) {
        return res.status(404).json({ message: 'Faol test urinish topilmadi' })
      }
      const questionIds = new Set(attempt.exam.test.questions.map((item) => item.id))
      const answers = Object.fromEntries(
        Object.entries(req.body?.answers ?? {}).filter(
          ([id, answer]) => questionIds.has(id) && Number.isInteger(answer) && Number(answer) >= 0 && Number(answer) <= 3
        )
      ) as Record<string, number>
      attempt.answers = answers
      attempt.currentQuestion = Math.min(
        attempt.exam.test.questions.length,
        Math.max(1, Number(req.body?.currentQuestion ?? 1))
      )
      attempt.heartbeatAt = new Date().toISOString()
      this.updateStudent(deviceId, {
        currentQuestion: attempt.currentQuestion,
        answeredCount: Object.keys(answers).length,
        heartbeatAt: attempt.heartbeatAt
      })
      this.broadcast({ type: 'students:changed' })
      res.json({ ok: true })
    })

    this.app.get('/api/students', (_req, res) => res.json(this.connectedStudents()))
    this.app.get('/api/results', (_req, res) => res.json(this.database.listResults()))
    this.app.get('/api/exams', (_req, res) => res.json(this.database.listExamHistory()))

    this.app.post('/api/results', (req, res) => {
      const submission = req.body as StudentSubmission
      const test = this.database.getTest(String(submission.testId ?? ''))
      if (!test || !submission.id || !submission.fish || !submission.group || !submission.deviceId) {
        return res.status(400).json({ message: "Natija ma'lumotlari to'liq emas" })
      }
      if (!submission.publishedTestId || !this.sessionPublicationIds.has(submission.publishedTestId)) {
        return res.status(409).json({ message: 'Bu natija oldingi server sessiyasiga tegishli' })
      }

      const attempt = this.attempts.get(submission.sessionId)
      if (attempt && attempt.student.deviceId !== submission.deviceId) {
        return res.status(403).json({ message: 'Urinish boshqa kompyuterga tegishli' })
      }
      const submittedQuestionIds = Array.isArray(submission.questionIds)
        ? submission.questionIds
        : Object.keys(submission.answers ?? {})
      const allowedIds = new Set(
        attempt?.exam.test.questions.map((item) => item.id) ??
        (submittedQuestionIds.length ? submittedQuestionIds : test.questions.map((item) => item.id))
      )
      const selectedQuestions = test.questions.filter((question) => allowedIds.has(question.id))
      if (!selectedQuestions.length) {
        return res.status(400).json({ message: 'Test savollari topilmadi' })
      }
      const answerOutcomes = selectedQuestions.map((question) => {
        const selected = submission.answers?.[question.id]
        return {
          questionId: question.id,
          questionText: question.text,
          selectedIndex: Number.isInteger(selected) ? selected : null,
          selectedAnswer: Number.isInteger(selected) ? question.options[selected] ?? null : null,
          correctIndex: question.correctIndex,
          correctAnswer: question.options[question.correctIndex],
          isCorrect: selected === question.correctIndex
        }
      })
      const score = answerOutcomes.filter((item) => item.isCorrect).length
      const total = selectedQuestions.length
      const submittedAt = new Date().toISOString()
      const startedAt = attempt?.exam.startedAt || submission.startedAt || submittedAt
      const durationSeconds = Math.max(
        0,
        Math.round((new Date(submittedAt).getTime() - new Date(startedAt).getTime()) / 1000)
      )
      const result: StoredResult = {
        ...submission,
        publishedTestId: attempt?.exam.publishedTestId || submission.publishedTestId || '',
        computerName: String(submission.computerName || 'Noma’lum kompyuter'),
        questionIds: selectedQuestions.map((item) => item.id),
        startedAt,
        submittedAt,
        durationSeconds,
        testTitle: test.title,
        score,
        total,
        percentage: total ? Math.round((score / total) * 10000) / 100 : 0,
        answerOutcomes,
        synced: true
      }
      const identityKey = attempt?.identityKey || this.identityKey(submission)
      this.database.saveResult(result, identityKey)
      void Promise.resolve(this.onResultSaved?.()).catch(() => undefined)
      this.attempts.delete(submission.sessionId)
      this.updateStudent(submission.deviceId, {
        status: 'completed',
        sessionId: undefined,
        testTitle: test.title,
        currentQuestion: total,
        answeredCount: Object.keys(submission.answers ?? {}).length,
        totalQuestions: total,
        heartbeatAt: submittedAt
      })
      this.broadcast({ type: 'result:received', resultId: result.id })
      this.broadcast({ type: 'students:changed' })

      res.status(201).json({
        ok: true,
        resultId: result.id,
        showResult: test.showResult,
        ...(test.showResult
          ? { score: result.score, total: result.total, percentage: result.percentage }
          : {})
      })
    })
  }

  private configureWebSocket(): void {
    this.wss.on('connection', (socket, request) => {
      if (!this.isIpAllowed(request.socket.remoteAddress)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Bu kompyuter IP manzili serverda ruxsat etilmagan' } satisfies ServerEvent))
        socket.close(1008, 'IP ruxsat etilmagan')
        return
      }
      this.clientIps.set(socket, this.normalizeRemoteIp(request.socket.remoteAddress))
      socket.send(JSON.stringify({
        type: 'server:ready',
        tests: this.listPublishedTests(),
        settings: this.database.getSettings()
      } satisfies ServerEvent))

      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as ClientMessage
          if (message.type !== 'student:join') return
          const student = this.normalizeIdentity(message.student)
          if (!student || !this.identityAllowed(student)) {
            socket.send(JSON.stringify({
              type: 'student:kicked',
              message: "Student ma'lumoti server ro'yxatiga mos kelmadi"
            } satisfies ServerEvent))
            socket.close()
            return
          }
          for (const [otherSocket, connected] of this.students) {
            if (connected.deviceId === student.deviceId && otherSocket !== socket) {
              otherSocket.close()
              this.students.delete(otherSocket)
            }
          }
          this.students.set(socket, {
            ...student,
            connectedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            online: true,
            status: 'connected'
          })
          this.broadcast({ type: 'students:changed' })
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: "Xabarni o'qib bo'lmadi" } satisfies ServerEvent))
        }
      })

      socket.on('close', () => {
        this.students.delete(socket)
        this.clientIps.delete(socket)
        this.broadcast({ type: 'students:changed' })
      })
    })
  }

  private connectedStudents(): ConnectedStudent[] {
    return [...this.students.values()].sort((a, b) => {
      if (a.status === 'working' && b.status !== 'working') return -1
      if (b.status === 'working' && a.status !== 'working') return 1
      return a.fish.localeCompare(b.fish)
    })
  }

  private listPublishedTests(): PublishedTest[] {
    return [...this.publishedTests.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  }

  private listCurrentRoster(): StudentRosterEntry[] {
    return this.database.getSettings().identityMode === 'face'
      ? this.faceProfiles.listRoster()
      : this.database.listRoster()
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event)
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  private updateStudent(deviceId: string, patch: Partial<ConnectedStudent>): void {
    for (const [socket, student] of this.students) {
      if (student.deviceId === deviceId) this.students.set(socket, { ...student, ...patch })
    }
  }

  private identityKey(student: Pick<StudentIdentity, 'studentId' | 'fish' | 'group'>): string {
    return student.studentId?.trim()
      ? `student:${student.studentId.trim()}`
      : `manual:${student.fish.trim().toLocaleLowerCase('uz-UZ')}|${student.group.trim().toLocaleLowerCase('uz-UZ')}`
  }

  private identityAllowed(student: StudentIdentity): boolean {
    if (this.database.getSettings().identityMode === 'manual') return true
    return this.listCurrentRoster().some(
      (entry) => entry.id === student.studentId && entry.fish === student.fish && entry.group === student.group
    )
  }

  private normalizeDescriptor(input: unknown): number[] | null {
    if (!Array.isArray(input) || input.length < 64 || input.length > 4096) return null
    const descriptor = input.map(Number)
    return descriptor.every(Number.isFinite) ? descriptor : null
  }

  private enrollmentStatus(request: FaceEnrollmentRequest): FaceEnrollmentStatus {
    return {
      id: request.id,
      status: request.status,
      requestedAt: request.requestedAt,
      student: request.student,
      message: request.message
    }
  }

  private isLocalRequest(ip: string | undefined): boolean {
    return this.normalizeRemoteIp(ip) === '127.0.0.1' || ip === '::1'
  }

  private normalizeRemoteIp(ip: string | undefined): string {
    const value = String(ip ?? '').trim()
    if (value.startsWith('::ffff:')) return value.slice(7)
    return value
  }

  private isIpAllowed(ip: string | undefined): boolean {
    if (this.isLocalRequest(ip)) return true
    const settings = this.database.getSettings()
    if (settings.accessMode === 'open') return true
    return settings.allowedIps.includes(this.normalizeRemoteIp(ip))
  }

  private normalizeAllowedIps(input: unknown): string[] | null {
    const values = Array.isArray(input) ? input.map(String) : String(input ?? '').split(',')
    const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    const validIpv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
    return normalized.every((value) => validIpv4.test(value)) ? normalized : null
  }

  private disconnectUnauthorizedClients(): void {
    for (const [socket, ip] of this.clientIps) {
      if (this.isIpAllowed(ip)) continue
      socket.send(JSON.stringify({ type: 'student:kicked', message: 'Serverda ushbu IP manzil uchun ruxsat yopildi' } satisfies ServerEvent))
      socket.close(1008, 'IP ruxsati yopildi')
    }
  }

  private removeExpiredFaceEnrollmentRequests(): void {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [id, request] of this.faceEnrollmentRequests) {
      if (new Date(request.requestedAt).getTime() < cutoff) this.faceEnrollmentRequests.delete(id)
    }
  }

  private normalizePhoto(input: unknown): string | undefined {
    const photo = String(input ?? '')
    return /^data:image\/(jpeg|jpg|png);base64,/i.test(photo) && photo.length <= 25_000_000 ? photo : undefined
  }

  private faceSimilarity(first: number[], second: number[]): number {
    let sum = 0
    for (let index = 0; index < first.length; index += 1) {
      const difference = first[index] - second[index]
      sum += difference * difference
    }
    const distance = Math.round(100 * 25 * sum) / 100
    if (distance === 0) return 1
    const normalized = (1 - Math.sqrt(distance) / 100 - 0.2) / 0.6
    return Math.round(100 * Math.max(Math.min(normalized, 1), 0)) / 100
  }

  private normalizeIdentity(input: Partial<StudentIdentity> | undefined): StudentIdentity | null {
    const fish = String(input?.fish ?? '').trim()
    const group = String(input?.group ?? '').trim()
    const deviceId = String(input?.deviceId ?? '').trim()
    const computerName = String(input?.computerName ?? '').trim()
    const studentId = String(input?.studentId ?? '').trim() || undefined
    if (!fish || !group || !deviceId || !computerName) return null
    return { fish, group, deviceId, computerName, studentId }
  }

  private normalizeRoster(input: unknown): StudentRosterEntry[] | null {
    if (!Array.isArray(input)) return null
    const entries = input.map((item) => ({
      id: String(item?.id ?? createId('student')).trim(),
      fish: String(item?.fish ?? '').trim(),
      group: String(item?.group ?? '').trim()
    }))
    if (entries.some((item) => !item.id || !item.fish || !item.group)) return null
    if (new Set(entries.map((item) => item.id)).size !== entries.length) return null
    return entries
  }

  private selectQuestions(test: Test): Test['questions'] {
    const questions = [...test.questions]
    if (test.questionOrder === 'random') {
      for (let index = questions.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1))
        ;[questions[index], questions[swapIndex]] = [questions[swapIndex], questions[index]]
      }
    }
    return questions.slice(0, Math.min(test.questionCount, questions.length))
  }

  private normalizeTest(input: Partial<Test>): Test | null {
    const title = String(input.title ?? '').trim()
    const durationMinutes = Number(input.durationMinutes)
    const questions = Array.isArray(input.questions) ? input.questions : []
    const questionCount = Number(input.questionCount ?? questions.length)
    const questionOrder = input.questionOrder === 'random' ? 'random' : 'sequential'
    if (
      !title ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes < 1 ||
      questions.length < 1 ||
      !Number.isInteger(questionCount) ||
      questionCount < 1 ||
      questionCount > questions.length
    ) return null
    if (questions.some((question) =>
      !question.id ||
      !String(question.text ?? '').trim() ||
      !Array.isArray(question.options) ||
      question.options.length !== 4 ||
      question.options.some((option) => !String(option).trim()) ||
      !Number.isInteger(question.correctIndex) ||
      question.correctIndex < 0 ||
      question.correctIndex > 3
    )) return null

    const timestamp = new Date().toISOString()
    return {
      id: input.id || createId('test'),
      title,
      durationMinutes,
      questionCount,
      questionOrder,
      showResult: Boolean(input.showResult),
      questions: questions.map((question) => ({
        id: question.id,
        text: String(question.text).trim(),
        options: question.options.map(String) as [string, string, string, string],
        correctIndex: question.correctIndex
      })),
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp
    }
  }
}
