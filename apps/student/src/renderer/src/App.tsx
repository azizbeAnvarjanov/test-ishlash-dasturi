import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createId,
  type AppUpdateState,
  type BootstrapData,
  type ExamSession,
  type FaceEnrollmentStatus,
  type FaceRecognitionResponse,
  type PublishedTest,
  type ResultReceipt,
  type ServerEvent,
  type ServerSettings,
  type StudentIdentity,
  type StudentRosterEntry,
  type StudentSubmission
} from '@test/shared'
import { captureVideoPhoto, detectProctorFace, extractFaceDescriptor, prepareFaceEngine, prepareProctorEngine } from './face-engine'

type Screen = 'setup' | 'identity' | 'tests' | 'exam' | 'completed'
type ProctorStatus = 'loading' | 'ok' | 'warning' | 'error'
type ProctorWarning = { count: number; message: string; final: boolean }
type CameraDevice = { deviceId: string; label: string }

const PROCTOR_MAX_WARNINGS = 3
// Inferensiyalar orasida CPU/GPU va React UI uchun bo'sh vaqt qoldiramiz.
const PROCTOR_CHECK_INTERVAL_MS = 1000

const formatBytes = (bytes = 0): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
const PROCTOR_VIOLATION_GRACE_MS = 3000
const PROCTOR_MAX_RESULT_AGE_MS = 2500
const PROCTOR_WARNING_COOLDOWN_MS = 3500
const PROCTOR_MODAL_AUTO_CLOSE_MS = 2000
const CAMERA_DEVICE_STORAGE_KEY = 'student-camera-device-id'

const normalizeServer = (value: string): string => {
  const clean = value.trim().replace(/^https?:\/\//, '').replace(/^ws:\/\//, '').replace(/\/.*$/, '')
  return clean.includes(':') ? clean : `${clean}:4780`
}

async function api<T>(server: string, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`http://${server}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers }
  })
  const body = await response.json().catch(() => ({})) as { message?: string }
  if (!response.ok) throw new Error(body.message || 'Server xatosi')
  return body as T
}

const stopMediaStream = (stream: MediaStream | null): void => {
  stream?.getTracks().forEach((track) => track.stop())
}

const cameraErrorMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback

const listVideoInputDevices = async (): Promise<CameraDevice[]> => {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'videoinput' && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Kamera ${index + 1}`
    }))
}

const buildCameraConstraints = (
  cameraDeviceId: string,
  width: number,
  height: number
): MediaTrackConstraints => {
  const constraints: MediaTrackConstraints = {
    width: { ideal: width },
    height: { ideal: height }
  }
  if (cameraDeviceId) {
    constraints.deviceId = { exact: cameraDeviceId }
  } else {
    constraints.facingMode = 'user'
  }
  return constraints
}

const openCameraStream = async (
  cameraDeviceId: string,
  width: number,
  height: number
): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Bu kompyuterda kameradan foydalanib bo'lmaydi.")
  }

  const attemptedDeviceIds = new Set<string>()
  const tryOpen = async (constraints: MediaTrackConstraints): Promise<MediaStream | null> => {
    const exactDeviceId = typeof constraints.deviceId === 'object' && constraints.deviceId && 'exact' in constraints.deviceId
      ? String(constraints.deviceId.exact)
      : ''
    if (exactDeviceId) {
      if (attemptedDeviceIds.has(exactDeviceId)) return null
      attemptedDeviceIds.add(exactDeviceId)
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints })
    } catch {
      return null
    }
  }

  // Avval foydalanuvchi tanlagan kamerani ochamiz. USB kamera uzilgan bo'lsa,
  // Chromium saqlangan eski deviceId sabab boshqa kameraga o'zi o'tmaydi.
  if (cameraDeviceId) {
    const selectedStream = await tryOpen(buildCameraConstraints(cameraDeviceId, width, height))
    if (selectedStream) return selectedStream
  }

  // Ichki/default kamera ishlasa shu yerda ochiladi.
  const automaticStream = await tryOpen(buildCameraConstraints('', width, height))
  if (automaticStream) return automaticStream

  // Windows default kamerani ocholmagan holatda barcha mavjud kameralarni
  // bittadan tekshiramiz (masalan, uzilgan USB kamera default bo'lib qolganida).
  try {
    const cameras = await listVideoInputDevices()
    for (const camera of cameras) {
      const stream = await tryOpen(buildCameraConstraints(camera.deviceId, width, height))
      if (stream) return stream
    }
  } catch {
    // Quyidagi foydalanuvchiga tushunarli umumiy xabar ko'rsatiladi.
  }

  throw new Error("Ishlaydigan kamera topilmadi. Windows kamera ruxsatini va USB ulanishini tekshiring.")
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('setup')
  const [serverInput, setServerInput] = useState(() => localStorage.getItem('server') ?? '127.0.0.1:4780')
  const [selectedCameraId, setSelectedCameraId] = useState(() => localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY) ?? '')
  const [server, setServer] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [computerName, setComputerName] = useState('')
  const [resultsDirectory, setResultsDirectory] = useState('')
  const [settings, setSettings] = useState<ServerSettings>({ identityMode: 'manual', accessMode: 'open', allowedIps: [] })
  const [roster, setRoster] = useState<StudentRosterEntry[]>([])
  const [publishedTests, setPublishedTests] = useState<PublishedTest[]>([])
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [fish, setFish] = useState(() => localStorage.getItem('fish') ?? '')
  const [group, setGroup] = useState(() => localStorage.getItem('group') ?? '')
  const [identity, setIdentity] = useState<StudentIdentity | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [exam, setExam] = useState<ExamSession | null>(null)
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [receipt, setReceipt] = useState<ResultReceipt | null>(null)
  const [synced, setSynced] = useState(true)
  const socketRef = useRef<WebSocket | null>(null)
  const submittingRef = useRef(false)
  const identityRef = useRef<StudentIdentity | null>(null)
  const serverRef = useRef('')
  const examRef = useRef<ExamSession | null>(null)
  const answersRef = useRef<Record<string, number>>({})
  const submitExamRef = useRef<(() => Promise<void>) | null>(null)
  const examSyncTimerRef = useRef<number | null>(null)

  const saveSelectedCameraId = useCallback((nextCameraId: string): void => {
    setSelectedCameraId(nextCameraId)
    if (nextCameraId) {
      localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, nextCameraId)
    } else {
      localStorage.removeItem(CAMERA_DEVICE_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    void window.studentDesktop.getInfo().then((info) => {
      setDeviceId(info.deviceId)
      setComputerName(info.computerName)
      setResultsDirectory(info.resultsDirectory)
    })
    return () => socketRef.current?.close()
  }, [])

  useEffect(() => {
    const stopKeys = (event: KeyboardEvent): void => {
      if (screen !== 'exam') return
      if (
        event.key === 'F4' ||
        event.key === 'Escape' ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey && ['w', 'r', 't', 'n', 'p', 's', 'u', 'i', 'j', 'c', 'v', 'x'].includes(event.key.toLowerCase())
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', stopKeys, true)
    return () => window.removeEventListener('keydown', stopKeys, true)
  }, [screen])

  const syncPending = useCallback(async (serverAddress: string): Promise<void> => {
    const pending = await window.studentDesktop.listPending()
    for (const item of pending) {
      try {
        const pendingReceipt = await api<ResultReceipt>(serverAddress, '/results', {
          method: 'POST',
          body: JSON.stringify(item.submission)
        })
        await window.studentDesktop.markSynced(item.file, pendingReceipt)
      } catch {
        // Keyingi ulanishda yana uriniladi.
      }
    }
  }, [])

  const reloadPublishedTests = useCallback(async (): Promise<void> => {
    if (!serverRef.current) return
    try {
      const tests = await api<PublishedTest[]>(serverRef.current, '/published-tests')
      setPublishedTests(tests)
    } catch {
      // WebSocket qayta ulanganda yangilanadi.
    }
  }, [])

  const openSocket = useCallback((serverAddress: string, student: StudentIdentity): void => {
    socketRef.current?.close()
    const socket = new WebSocket(`ws://${serverAddress}`)
    socketRef.current = socket
    socket.onopen = () => {
      setConnected(true)
      setError('')
      socket.send(JSON.stringify({ type: 'student:join', student }))
      void syncPending(serverAddress)
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerEvent
      if (message.type === 'server:ready' || message.type === 'tests:changed') {
        setPublishedTests(message.tests)
      }
      if (message.type === 'exam:stopped' && examRef.current?.id === message.sessionId) {
        setError(message.message || "Test server tomonidan to'xtatildi")
        void submitExamRef.current?.()
      }
      if (message.type === 'student:kicked') {
        setError(message.message)
        if (!examRef.current) setScreen('identity')
      }
    }
    socket.onclose = () => {
      setConnected(false)
      if (!examRef.current) setError('Server bilan aloqa uzildi. Qayta ulanish kerak.')
    }
    socket.onerror = () => setConnected(false)
  }, [syncPending])

  const connectServer = async (): Promise<void> => {
    if (!serverInput.trim()) return setError('Server IP manzilini kiriting')
    if (!deviceId || !computerName) return setError("Kompyuter ma'lumoti tayyor emas, biroz kuting")
    setConnecting(true)
    setError('')
    const address = normalizeServer(serverInput)
    try {
      const data = await api<BootstrapData>(address, '/bootstrap')
      serverRef.current = address
      setServer(address)
      setServerInput(address)
      setSettings(data.settings)
      setRoster(data.roster)
      setPublishedTests(data.tests)
      localStorage.setItem('server', address)
      setScreen('identity')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Server topilmadi')
    } finally {
      setConnecting(false)
    }
  }

  const enterAsStudent = (nextIdentity: StudentIdentity): void => {
    localStorage.setItem('fish', nextIdentity.fish)
    localStorage.setItem('group', nextIdentity.group)
    identityRef.current = nextIdentity
    setIdentity(nextIdentity)
    setError('')
    setScreen('tests')
    openSocket(serverRef.current, nextIdentity)
  }

  const confirmIdentity = (): void => {
    let nextIdentity: StudentIdentity | null = null
    if (settings.identityMode === 'roster') {
      const selected = roster.find((entry) => entry.id === selectedStudentId)
      if (selected) {
        nextIdentity = {
          fish: selected.fish,
          group: selected.group,
          studentId: selected.id,
          deviceId,
          computerName
        }
      }
    } else if (fish.trim() && group.trim()) {
      nextIdentity = { fish: fish.trim(), group: group.trim(), deviceId, computerName }
    }
    if (!nextIdentity) return setError("Student ma'lumotini to'liq tanlang yoki kiriting")
    enterAsStudent(nextIdentity)
  }

  const startTest = async (published: PublishedTest): Promise<void> => {
    if (!identityRef.current) return
    setError('')
    try {
      const startedExam = await api<ExamSession>(serverRef.current, `/published-tests/${published.id}/start`, {
        method: 'POST',
        body: JSON.stringify({ student: identityRef.current })
      })
      submittingRef.current = false
      if (examSyncTimerRef.current) window.clearTimeout(examSyncTimerRef.current)
      examRef.current = startedExam
      answersRef.current = {}
      setExam(startedExam)
      setAnswers({})
      setQuestionIndex(0)
      setSecondsLeft(Math.max(0, Math.ceil((new Date(startedExam.endsAt).getTime() - Date.now()) / 1000)))
      setReceipt(null)
      setScreen('exam')
      await window.studentDesktop.setExamMode(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Testni yuklab bo‘lmadi')
    }
  }

  const buildSubmission = useCallback((currentExam: ExamSession, currentAnswers: Record<string, number>): StudentSubmission => {
    const student = identityRef.current!
    const submittedAt = new Date().toISOString()
    return {
      id: createId('result'),
      sessionId: currentExam.id,
      publishedTestId: currentExam.publishedTestId,
      testId: currentExam.testId,
      fish: student.fish,
      group: student.group,
      studentId: student.studentId,
      deviceId: student.deviceId,
      computerName: student.computerName,
      questionIds: currentExam.test.questions.map((question) => question.id),
      answers: currentAnswers,
      startedAt: currentExam.startedAt,
      submittedAt,
      durationSeconds: Math.max(
        0,
        Math.round((new Date(submittedAt).getTime() - new Date(currentExam.startedAt).getTime()) / 1000)
      )
    }
  }, [])

  const submitExam = useCallback(async (): Promise<void> => {
    const currentExam = examRef.current
    if (!currentExam || submittingRef.current || !identityRef.current) return
    submittingRef.current = true
    if (examSyncTimerRef.current) {
      window.clearTimeout(examSyncTimerRef.current)
      examSyncTimerRef.current = null
    }
    const submission = buildSubmission(currentExam, answersRef.current)
    let file = ''
    let sent = false
    let nextReceipt: ResultReceipt | null = null

    try {
      file = await window.studentDesktop.saveResult(
        submission,
        currentExam.test.title,
        currentExam.test.questions.length
      )
    } catch {
      // Lokal saqlashda xato bo'lsa ham serverga yuborishga uriniladi.
    }

    setSynced(false)
    setReceipt(null)
    setScreen('completed')
    setExam(null)
    examRef.current = null
    await window.studentDesktop.setExamMode(false)

    try {
      nextReceipt = await api<ResultReceipt>(serverRef.current, '/results', {
        method: 'POST',
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(7000)
      })
      if (file) await window.studentDesktop.markSynced(file, nextReceipt)
      sent = true
    } catch {
      sent = false
    }
    setSynced(sent)
    setReceipt(nextReceipt)
  }, [buildSubmission])

  useEffect(() => {
    submitExamRef.current = submitExam
  }, [submitExam])

  useEffect(() => {
    if (screen !== 'exam' || !exam) return
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((new Date(exam.endsAt).getTime() - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) {
        window.clearInterval(timer)
        void submitExam()
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [exam, screen, submitExam])

  const sendProgress = useCallback((nextAnswers: Record<string, number>, nextQuestion: number): void => {
    const currentExam = examRef.current
    const student = identityRef.current
    if (!currentExam || !student) return
    void api(serverRef.current, '/exam/progress', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: currentExam.id,
        deviceId: student.deviceId,
        answers: nextAnswers,
        currentQuestion: nextQuestion + 1
      })
    }).catch(() => undefined)
  }, [])

  const scheduleExamSync = useCallback((nextQuestion: number): void => {
    if (examSyncTimerRef.current) window.clearTimeout(examSyncTimerRef.current)
    examSyncTimerRef.current = window.setTimeout(() => {
      examSyncTimerRef.current = null
      const currentExam = examRef.current
      if (!currentExam) return
      const currentAnswers = answersRef.current
      void window.studentDesktop.saveDraft(currentExam, buildSubmission(currentExam, currentAnswers))
      sendProgress(currentAnswers, nextQuestion)
    }, 350)
  }, [buildSubmission, sendProgress])

  const chooseAnswer = (questionId: string, optionIndex: number): void => {
    const nextAnswers = { ...answersRef.current, [questionId]: optionIndex }
    answersRef.current = nextAnswers
    setAnswers(nextAnswers)
    if (examRef.current) scheduleExamSync(questionIndex)
  }

  const changeQuestion = (index: number): void => {
    setQuestionIndex(index)
    scheduleExamSync(index)
  }

  const manualSubmit = (): void => {
    void submitExam()
  }

  if (screen === 'setup') {
    return (
      <SetupScreen
        server={serverInput}
        computerName={computerName}
        connecting={connecting}
        error={error}
        resultsDirectory={resultsDirectory}
        selectedCameraId={selectedCameraId}
        onServer={setServerInput}
        onCamera={saveSelectedCameraId}
        onConnect={() => void connectServer()}
      />
    )
  }

  if (screen === 'identity') {
    if (settings.identityMode === 'face') {
      return (
        <FaceIdentityScreen
          server={server}
          deviceId={deviceId}
          computerName={computerName}
          cameraDeviceId={selectedCameraId}
          onBack={() => setScreen('setup')}
          onIdentified={(student) => enterAsStudent({
            fish: student.fish,
            group: student.group,
            studentId: student.id,
            deviceId,
            computerName
          })}
        />
      )
    }
    return (
      <IdentityScreen
        settings={settings}
        roster={roster}
        selectedStudentId={selectedStudentId}
        fish={fish}
        group={group}
        server={server}
        computerName={computerName}
        error={error}
        onSelectedStudent={setSelectedStudentId}
        onFish={setFish}
        onGroup={setGroup}
        onBack={() => setScreen('setup')}
        onContinue={confirmIdentity}
      />
    )
  }

  if (screen === 'tests') {
    return (
      <TestSelectionScreen
        identity={identity!}
        tests={publishedTests}
        connected={connected}
        error={error}
        onReload={() => void reloadPublishedTests()}
        onReconnect={() => identityRef.current && openSocket(serverRef.current, identityRef.current)}
        onChangeStudent={() => {
          socketRef.current?.close()
          setScreen('identity')
        }}
        onStart={(test) => void startTest(test)}
      />
    )
  }

  if (screen === 'completed') {
    return (
      <CompletedScreen
        synced={synced}
        receipt={receipt}
        resultsDirectory={resultsDirectory}
        onContinue={() => {
          submittingRef.current = false
          setError('')
          setScreen('tests')
          void reloadPublishedTests()
        }}
      />
    )
  }

  if (!exam) return <></>
  const question = exam.test.questions[questionIndex]
  return (
    <ExamScreen
      exam={exam}
      questionIndex={questionIndex}
      answers={answers}
      secondsLeft={secondsLeft}
      connected={connected}
      cameraDeviceId={selectedCameraId}
      onAnswer={(optionIndex) => chooseAnswer(question.id, optionIndex)}
      onQuestion={changeQuestion}
      onSubmit={manualSubmit}
    />
  )
}

function SetupScreen(props: {
  server: string
  computerName: string
  connecting: boolean
  error: string
  resultsDirectory: string
  selectedCameraId: string
  onServer: (value: string) => void
  onCamera: (value: string) => void
  onConnect: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [cameras, setCameras] = useState<CameraDevice[]>([])
  const [cameraLoading, setCameraLoading] = useState(false)
  const [cameraStatus, setCameraStatus] = useState('Kameralar aniqlanmoqda...')
  const [cameraRefreshKey, setCameraRefreshKey] = useState(0)
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: 'idle',
    message: 'Yangi versiyani qo‘lda tekshirishingiz mumkin.',
    currentVersion: ''
  })

  useEffect(() => {
    void window.studentDesktop.getUpdateState().then(setUpdateState)
    return window.studentDesktop.onUpdateStatus(setUpdateState)
  }, [])

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("Bu kompyuterda kamera ro'yxatini o'qib bo'lmadi.")
      return undefined
    }

    let active = true
    let previewStream: MediaStream | null = null
    setCameraLoading(true)
    setCameraStatus('Kamera tekshirilmoqda...')

    void (async () => {
      try {
        previewStream = await openCameraStream(props.selectedCameraId, 640, 480)
        if (!active) {
          stopMediaStream(previewStream)
          return
        }

        const nextCameras = await listVideoInputDevices()
        const actualDeviceId = previewStream.getVideoTracks()[0]?.getSettings().deviceId || ''
        const actualCamera = nextCameras.find((camera) => camera.deviceId === actualDeviceId)
        const selectedExists = nextCameras.some((camera) => camera.deviceId === props.selectedCameraId)
        setCameras(nextCameras)

        if (videoRef.current) {
          videoRef.current.srcObject = previewStream
          await videoRef.current.play()
        }

        if (props.selectedCameraId && !selectedExists && actualDeviceId) {
          props.onCamera(actualDeviceId)
          setCameraStatus(`${actualCamera?.label || 'Mavjud kamera'} avtomatik tanlandi va saqlandi.`)
        } else {
          setCameraStatus(`${actualCamera?.label || 'Kamera'} ishlayapti. Tanlov avtomatik saqlanadi.`)
        }
      } catch (reason) {
        if (!active) return
        try {
          setCameras(await listVideoInputDevices())
        } catch {
          setCameras([])
        }
        setCameraStatus(cameraErrorMessage(reason, "Kamerani ishga tushirib bo'lmadi."))
      } finally {
        if (active) setCameraLoading(false)
      }
    })()

    return () => {
      active = false
      stopMediaStream(previewStream)
      if (videoRef.current?.srcObject === previewStream) videoRef.current.srcObject = null
    }
  }, [cameraRefreshKey, props.selectedCameraId, props.onCamera])

  useEffect(() => {
    const handleDeviceChange = (): void => {
      setCameraRefreshKey((current) => current + 1)
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
  }, [])

  const selectedCameraMissing = Boolean(
    props.selectedCameraId && !cameras.some((camera) => camera.deviceId === props.selectedCameraId)
  )

  const checkForUpdates = async (): Promise<void> => {
    try {
      setUpdateState(await window.studentDesktop.checkForUpdates())
    } catch (reason) {
      setUpdateState((current) => ({ ...current, status: 'error', message: reason instanceof Error ? reason.message : 'Yangilanishni tekshirib bo‘lmadi.' }))
    }
  }

  const downloadUpdate = async (): Promise<void> => setUpdateState(await window.studentDesktop.downloadUpdate())
  const installUpdate = async (): Promise<void> => setUpdateState(await window.studentDesktop.installUpdate())

  return (
    <div className="setup-page">
      <div className="setup-art">
        <div className="art-content">
          <img className="student-wordmark" src="/branding/logo.png" alt="Easy Testing Student" />
          <h1>Easy Testing Student</h1>
          <p>Avval serverga ulaning. Keyin student va ishlanadigan test alohida tanlanadi.</p>
          <div className="feature"><span>✓</span><div><strong>Xavfsiz test rejimi</strong><small>Test paytida chiqish va klavish kombinatsiyalari bloklanadi</small></div></div>
          <div className="feature"><span>✓</span><div><strong>Jonli monitoring</strong><small>Jarayon serverda savolma-savol ko‘rinadi</small></div></div>
          <div className="feature"><span>✓</span><div><strong>Avtomatik saqlash</strong><small>Natija server va kompyuterda saqlanadi</small></div></div>
        </div>
        <div className="decor one" /><div className="decor two" />
      </div>
      <div className="setup-form-wrap">
        <div className="setup-form">
          <span className="eyebrow">1-QADAM · SERVER</span>
          <h2>Serverga ulanish</h2>
          <p className="lead">Server va student kompyuteri bir xil LAN yoki Wi-Fi tarmog‘ida bo‘lsin.</p>
          {props.error && <div className="form-error">{props.error}</div>}
          <label><span>Server IP manzili</span><input value={props.server} onChange={(event) => props.onServer(event.target.value)} placeholder="Masalan: 192.168.1.10:4780" /></label>
          <div className="computer-chip">Kompyuter: <strong>{props.computerName || 'Aniqlanmoqda...'}</strong></div>
          <div className="camera-settings">
            <div className="camera-settings-head">
              <span>Kamera sozlamasi</span>
              <button disabled={cameraLoading} onClick={() => setCameraRefreshKey((current) => current + 1)}>
                {cameraLoading ? 'Tekshirilmoqda...' : 'Yangilash'}
              </button>
            </div>
            <select
              value={props.selectedCameraId}
              onChange={(event) => {
                props.onCamera(event.target.value)
                const selected = cameras.find((camera) => camera.deviceId === event.target.value)
                setCameraStatus(event.target.value ? `${selected?.label || 'Tanlangan kamera'} tekshirilmoqda...` : 'Avtomatik kamera tekshirilmoqda...')
              }}
            >
              <option value="">Avtomatik (ishlaydigan kamera)</option>
              {selectedCameraMissing && <option value={props.selectedCameraId}>Avval tanlangan kamera</option>}
              {cameras.map((camera) => (
                <option value={camera.deviceId} key={camera.deviceId}>{camera.label}</option>
              ))}
            </select>
            <div className="camera-preview">
              <video ref={videoRef} autoPlay muted playsInline />
              {cameraLoading && <span>Kamera ochilmoqda...</span>}
            </div>
            <small>{cameraStatus}</small>
          </div>
          <div className="student-update-settings">
            <div className="student-update-row">
              <div><strong>Dastur yangilanishi</strong><small>{updateState.message}</small></div>
              {updateState.status === 'available' ? (
                <button onClick={() => void downloadUpdate()}>Yuklash</button>
              ) : updateState.status === 'downloaded' ? (
                <button className="install-update-button" onClick={() => void installUpdate()}>Qayta o‘rnatish</button>
              ) : updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'busy' ? (
                <button disabled><span className="button-loader" />{updateState.status === 'downloading' ? 'Yuklanmoqda...' : 'Tekshirilmoqda...'}</button>
              ) : (
                <button onClick={() => void checkForUpdates()}>Yangilanishni tekshirish</button>
              )}
            </div>
            {(updateState.status === 'downloading' || updateState.status === 'downloaded') && (
              <div className="update-progress-wrap">
                <div className="update-progress-labels"><span>Yuklandi: <b>{formatBytes(updateState.transferred)}</b></span><span>Qoldi: <b>{formatBytes(Math.max(0, (updateState.total ?? 0) - (updateState.transferred ?? 0)))}</b></span><strong>{Math.round(updateState.percent ?? 0)}%</strong></div>
                <div className="update-progress-track"><span style={{ width: `${Math.min(100, updateState.percent ?? 0)}%` }} /></div>
              </div>
            )}
          </div>
          <button className="connect-button" disabled={props.connecting} onClick={props.onConnect}>{props.connecting ? 'Ulanmoqda...' : 'Serverga ulanish'} <b>→</b></button>
          <button className="folder-button" onClick={() => void window.studentDesktop.openResults()}>Natijalar papkasini ochish</button>
          <small className="path">{props.resultsDirectory}</small>
        </div>
      </div>
    </div>
  )
}

function FaceIdentityScreen(props: {
  server: string
  deviceId: string
  computerName: string
  cameraDeviceId: string
  onBack: () => void
  onIdentified: (student: StudentRosterEntry) => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [status, setStatus] = useState('Kamera va Face ID modeli tayyorlanmoqda...')
  const [notFound, setNotFound] = useState(false)
  const [enrollmentRequestId, setEnrollmentRequestId] = useState('')
  const enrollmentCaptureRef = useRef(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await prepareFaceEngine()
        const stream = await openCameraStream(props.cameraDeviceId, 640, 480)
        if (!active) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setReady(true)
        setStatus('Kameraga to‘g‘ri qarang va “Yuzni skanerlash” tugmasini bosing.')
      } catch (reason) {
        setStatus(reason instanceof Error ? reason.message : 'Kamerani ishga tushirib bo‘lmadi')
      }
    })()
    return () => {
      active = false
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [props.cameraDeviceId])

  useEffect(() => {
    if (!enrollmentRequestId) return undefined
    let active = true
    const checkStatus = async (): Promise<void> => {
      try {
        const response = await api<FaceEnrollmentStatus>(
          props.server,
          `/face/enrollment-requests/${enrollmentRequestId}/status`
        )
        if (!active) return
        if (response.status === 'scan_requested' && !enrollmentCaptureRef.current) {
          if (!videoRef.current) return
          enrollmentCaptureRef.current = true
          setScanning(true)
          setStatus('Server buyrug‘i olindi. Yuz skaner qilinmoqda...')
          try {
            const descriptor = await extractFaceDescriptor(videoRef.current)
            const photoDataUrl = captureVideoPhoto(videoRef.current)
            await api<FaceEnrollmentStatus>(props.server, `/face/enrollment-requests/${response.id}/capture`, {
              method: 'POST',
              body: JSON.stringify({ deviceId: props.deviceId, descriptor, photoDataUrl })
            })
            setStatus('Yuz serverga yuborildi. O‘qituvchi ma’lumotlaringizni kiritmoqda...')
          } catch (reason) {
            setStatus(reason instanceof Error ? reason.message : 'Yuzni server uchun skanerlashda xato')
          } finally {
            enrollmentCaptureRef.current = false
            setScanning(false)
          }
        } else if (response.status === 'scanned') {
          setStatus('Yuz serverga yetib bordi. O‘qituvchi ism, familiya va guruhni kiritishini kuting.')
        } else if (response.status === 'approved') {
          setEnrollmentRequestId('')
          setNotFound(false)
          setStatus('Student Face ID bazasiga qo‘shildi. Endi “Yuzni skanerlash” tugmasini bosib kiring.')
        } else if (response.status === 'rejected') {
          setEnrollmentRequestId('')
          setNotFound(true)
          setStatus(response.message || 'Registratsiya so‘rovi server tomonidan rad etildi.')
        }
      } catch (reason) {
        if (active) setStatus(reason instanceof Error ? reason.message : 'Server tasdig‘ini tekshirishda xato')
      }
    }
    void checkStatus()
    const timer = window.setInterval(() => void checkStatus(), 1500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [enrollmentRequestId, props.server, props.deviceId])

  const scan = async (): Promise<void> => {
    if (!videoRef.current || !ready) return
    setScanning(true)
    setNotFound(false)
    setStatus('Yuz skaner qilinmoqda...')
    try {
      const descriptor = await extractFaceDescriptor(videoRef.current)
      const response = await api<FaceRecognitionResponse>(props.server, '/face/recognize', {
        method: 'POST',
        body: JSON.stringify({ descriptor })
      })
      if (response.matched) {
        setStatus(`${response.student.fish} · ${response.student.group} aniqlandi`)
        props.onIdentified(response.student)
      } else {
        setNotFound(true)
        setStatus('Bu yuz server bazasida topilmadi. Server monitoriga skanerlash so‘rovi yuboring.')
      }
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'Yuzni aniqlashda xato')
    } finally {
      setScanning(false)
    }
  }

  const requestEnrollment = async (): Promise<void> => {
    setScanning(true)
    try {
      const response = await api<FaceEnrollmentStatus>(props.server, '/face/enrollment-requests', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: props.deviceId,
          computerName: props.computerName
        })
      })
      setEnrollmentRequestId(response.id)
      setNotFound(false)
      setStatus('So‘rov server monitoriga yuborildi. O‘qituvchi “Skanerlash” tugmasini bosishini kuting.')
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'Registratsiya so‘rovini yuborishda xato')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="face-page">
      <section className="face-card">
        <div className="face-heading">
          <div><span className="eyebrow">2-QADAM · FACE ID</span><h1>Yuz orqali kirish</h1><p>Ulangan webcam orqali yuzingiz server bazasidan tekshiriladi.</p></div>
          <button className="secondary-action" onClick={props.onBack}>Orqaga</button>
        </div>
        <div className="face-camera">
          <video ref={videoRef} autoPlay muted playsInline />
          <div className="face-guide"><span /></div>
          {scanning && <div className="scan-line" />}
        </div>
        <div className={notFound ? 'face-status error' : 'face-status'}>{status}</div>
        {!enrollmentRequestId && (
          <button className="connect-button compact face-scan-button" disabled={!ready || scanning} onClick={() => void scan()}>
            {scanning ? 'Skaner qilinmoqda...' : 'Yuzni skanerlash'}
          </button>
        )}
        {notFound && !enrollmentRequestId && (
          <div className="face-enrollment">
            <h3>Yangi student uchun so‘rov</h3>
            <p>Server monitoriga so‘rov yuboring. Skanerlashni o‘qituvchi serverdan boshlaydi.</p>
            <div className="button-row">
              <button className="secondary-action" onClick={() => setNotFound(false)}>Bekor qilish</button>
              <button className="connect-button compact" disabled={scanning} onClick={() => void requestEnrollment()}>
                {scanning ? 'Yuborilmoqda...' : 'Serverga so‘rov yuborish'}
              </button>
            </div>
          </div>
        )}
        {enrollmentRequestId && (
          <div className="face-enrollment waiting">
            <h3>Server buyrug‘i kutilmoqda</h3>
            <p>Kameraga to‘g‘ri qarab turing. O‘qituvchi “Skanerlash”ni bosganda yuz avtomatik olinadi.</p>
          </div>
        )}
        <small className="face-device">{props.computerName} · {props.deviceId.slice(0, 8)}</small>
      </section>
    </div>
  )
}

function IdentityScreen(props: {
  settings: ServerSettings
  roster: StudentRosterEntry[]
  selectedStudentId: string
  fish: string
  group: string
  server: string
  computerName: string
  error: string
  onSelectedStudent: (value: string) => void
  onFish: (value: string) => void
  onGroup: (value: string) => void
  onBack: () => void
  onContinue: () => void
}): React.JSX.Element {
  const [rosterSearch, setRosterSearch] = useState('')
  const normalizedSearch = rosterSearch.trim().toLocaleLowerCase('uz-UZ')
  const visibleRoster = normalizedSearch
    ? props.roster.filter((entry) =>
        `${entry.fish} ${entry.group}`.toLocaleLowerCase('uz-UZ').includes(normalizedSearch)
      )
    : props.roster

  return (
    <div className="center-page">
      <div className="identity-card">
        <span className="eyebrow">2-QADAM · STUDENT</span>
        <h1>Studentni aniqlash</h1>
        <p>{props.settings.identityMode === 'roster' ? "Server yuborgan ro'yxatdan o'zingizni tanlang." : "F.I.Sh va guruhni qo'lda kiriting."}</p>
        {props.error && <div className="form-error">{props.error}</div>}
        {props.settings.identityMode === 'roster' ? (
          <div className="roster-picker">
            <label><span>Studentni qidirish</span>
              <input
                value={rosterSearch}
                onChange={(event) => {
                  setRosterSearch(event.target.value)
                  props.onSelectedStudent('')
                }}
                placeholder="F.I.Sh yoki guruh bo‘yicha qidiring"
                autoFocus
              />
            </label>
            <label><span>Student ro‘yxati</span>
              <select value={props.selectedStudentId} disabled={!visibleRoster.length} onChange={(event) => props.onSelectedStudent(event.target.value)}>
                <option value="">{visibleRoster.length ? 'Studentni tanlang' : 'Mos student topilmadi'}</option>
                {visibleRoster.map((entry) => <option value={entry.id} key={entry.id}>{entry.fish} — {entry.group}</option>)}
              </select>
            </label>
            <small className="roster-search-count">{visibleRoster.length} ta student ko‘rsatildi</small>
          </div>
        ) : (
          <div className="identity-fields">
            <label><span>F.I.Sh</span><input value={props.fish} onChange={(event) => props.onFish(event.target.value)} placeholder="Familiya Ism Sharif" /></label>
            <label><span>Guruh</span><input value={props.group} onChange={(event) => props.onGroup(event.target.value)} placeholder="Masalan: 101-guruh" /></label>
          </div>
        )}
        {props.settings.identityMode === 'roster' && !props.roster.length && <div className="empty-box">Server ro‘yxati bo‘sh. O‘qituvchiga murojaat qiling.</div>}
        <div className="identity-meta"><span>Server: <b>{props.server}</b></span><span>Kompyuter: <b>{props.computerName}</b></span></div>
        <div className="button-row"><button className="secondary-action" onClick={props.onBack}>Orqaga</button><button className="connect-button compact" onClick={props.onContinue}>Davom etish →</button></div>
      </div>
    </div>
  )
}

function TestSelectionScreen(props: {
  identity: StudentIdentity
  tests: PublishedTest[]
  connected: boolean
  error: string
  onReload: () => void
  onReconnect: () => void
  onChangeStudent: () => void
  onStart: (test: PublishedTest) => void
}): React.JSX.Element {
  return (
    <div className="selection-page">
      <header className="selection-header">
        <div className="exam-brand"><img className="exam-brand-logo" src="/branding/logo.png" alt="Easy Testing Student" /><div><strong>Easy Testing Student</strong><span>Testni tanlash</span></div></div>
        <div className="selection-user"><div><strong>{props.identity.fish}</strong><small>{props.identity.group} · {props.identity.computerName}</small></div><button onClick={props.onChangeStudent}>O‘zgartirish</button></div>
      </header>
      <main className="selection-content">
        <div className="selection-title">
          <div><span className="eyebrow">3-QADAM · TEST</span><h1>Ishlanadigan testni tanlang</h1><p>Server tomonidan yuborilgan testlar shu yerda ko‘rinadi.</p></div>
          <div className={props.connected ? 'connection-badge online-net' : 'connection-badge offline-net'}>● {props.connected ? 'Serverga ulangan' : 'Aloqa uzilgan'}</div>
        </div>
        {props.error && <div className="form-error">{props.error}</div>}
        {!props.connected && <button className="connect-button compact" onClick={props.onReconnect}>Qayta ulanish</button>}
        <div className="student-test-grid">
          {props.tests.map((test) => (
            <article className="student-test-card" key={test.id}>
              <div className="test-card-icon">T</div>
              <div className="test-card-copy"><span>TEST</span><h2>{test.title}</h2><div className="test-rules"><b>⏱ {test.durationMinutes} daqiqa</b><b>☷ {test.questionCount} ta savol</b><b>{test.questionOrder === 'random' ? '⤨ Random' : '→ Ketma-ket'}</b><b>{test.showResult ? '✓ Natija ko‘rinadi' : '◉ Natija yashirin'}</b></div></div>
              <button disabled={!props.connected} onClick={() => props.onStart(test)}>Testni yuklash</button>
            </article>
          ))}
        </div>
        {!props.tests.length && <div className="empty-tests"><div>⌛</div><h2>Hozircha test yuborilmagan</h2><p>O‘qituvchi test yuborganda bu ro‘yxatda paydo bo‘ladi.</p><button onClick={props.onReload}>Yangilash</button></div>}
      </main>
    </div>
  )
}

function CompletedScreen(props: {
  synced: boolean
  receipt: ResultReceipt | null
  resultsDirectory: string
  onContinue: () => void
}): React.JSX.Element {
  return (
    <div className="center-page">
      <div className="completed-card">
        <div className="success-check">✓</div>
        <span className="eyebrow">TEST YAKUNLANDI</span>
        <h1>Javoblaringiz saqlandi</h1>
        {props.receipt?.showResult ? (
          <div className="student-result">
            <strong>{props.receipt.score} / {props.receipt.total}</strong>
            <span>{props.receipt.percentage}% natija</span>
          </div>
        ) : (
          <p>Bu test sozlamasida natijani studentga ko‘rsatish o‘chirilgan.</p>
        )}
        <div className={props.synced ? 'sync-state good' : 'sync-state warning'}>
          <span>{props.synced ? '✓' : '!'}</span>
          <div><strong>{props.synced ? 'Serverga yuborildi' : 'Yuborish kutilmoqda'}</strong><small>Natija ushbu kompyuterda ham saqlandi</small></div>
        </div>
        <button className="connect-button compact" onClick={props.onContinue}>Testlar ro‘yxatiga qaytish</button>
        <button className="folder-button" onClick={() => void window.studentDesktop.openResults()}>Natijalar papkasini ochish</button>
        <small className="path">{props.resultsDirectory}</small>
      </div>
    </div>
  )
}

function ProctorCamera(props: {
  cameraDeviceId: string
  onTerminate: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const onTerminateRef = useRef(props.onTerminate)
  const activeRef = useRef(false)
  const detectingRef = useRef(false)
  const violationStartedAtRef = useRef<number | null>(null)
  const consecutiveViolationsRef = useRef(0)
  const warningConfirmationRef = useRef(false)
  const cooldownUntilRef = useRef(0)
  const finalizingRef = useRef(false)
  const warningCountRef = useRef(0)
  const modalTimerRef = useRef<number | null>(null)
  const finalizeTimerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<ProctorStatus>('loading')
  const [statusText, setStatusText] = useState('Kamera nazorati tayyorlanmoqda...')
  const [warningCount, setWarningCount] = useState(0)
  const [warningModal, setWarningModal] = useState<ProctorWarning | null>(null)

  useEffect(() => {
    onTerminateRef.current = props.onTerminate
  }, [props.onTerminate])

  const clearModalTimer = (): void => {
    if (modalTimerRef.current) window.clearTimeout(modalTimerRef.current)
    modalTimerRef.current = null
  }

  const showWarning = useCallback((message: string): void => {
    if (finalizingRef.current) return

    const nextCount = Math.min(PROCTOR_MAX_WARNINGS, warningCountRef.current + 1)
    const final = nextCount >= PROCTOR_MAX_WARNINGS
    warningCountRef.current = nextCount
    setWarningCount(nextCount)
    violationStartedAtRef.current = null
    consecutiveViolationsRef.current = 0
    warningConfirmationRef.current = false
    cooldownUntilRef.current = Date.now() + PROCTOR_WARNING_COOLDOWN_MS
    clearModalTimer()

    setStatus('warning')
    setStatusText(final ? '3-ogohlantirish. Test avtomatik yakunlanmoqda.' : message)
    setWarningModal({
      count: nextCount,
      final,
      message: final
        ? `${message} 3-ogohlantirish bo‘lgani uchun test avtomatik yakunlanadi.`
        : `${message} Boshingizni va nigohingizni kameraga to‘g‘ri qarating.`
    })

    if (final) {
      finalizingRef.current = true
      finalizeTimerRef.current = window.setTimeout(() => {
        onTerminateRef.current()
      }, 1800)
      return
    }

    modalTimerRef.current = window.setTimeout(() => {
      setWarningModal((current) => current?.count === nextCount ? null : current)
    }, PROCTOR_MODAL_AUTO_CLOSE_MS)
  }, [])

  const runCheck = useCallback(async (): Promise<void> => {
    if (!videoRef.current || detectingRef.current || finalizingRef.current) return

    detectingRef.current = true
    const capturedAt = Date.now()
    try {
      const check = await detectProctorFace(videoRef.current)
      if (!activeRef.current) return

      // Juda sekin kompyuterda kech qaytgan eski kadr foydalanuvchining hozirgi
      // holati sifatida baholanmaydi va ogohlantirishga qo'shilmaydi.
      if (Date.now() - capturedAt > PROCTOR_MAX_RESULT_AGE_MS) {
        setStatus('loading')
        setStatusText('Kamera holati yangilanmoqda...')
        violationStartedAtRef.current = null
        consecutiveViolationsRef.current = 0
        warningConfirmationRef.current = false
        return
      }

      if (check.ok) {
        violationStartedAtRef.current = null
        consecutiveViolationsRef.current = 0
        warningConfirmationRef.current = false
        setStatus('ok')
        setStatusText('Yuz va nigoh to‘g‘ri. Nazorat faol.')
        return
      }

      const now = Date.now()
      setStatus('warning')

      if (now < cooldownUntilRef.current) {
        setStatusText(check.message)
        return
      }

      consecutiveViolationsRef.current += 1
      if (!violationStartedAtRef.current) violationStartedAtRef.current = now
      const elapsed = now - violationStartedAtRef.current
      const remaining = Math.max(0, Math.ceil((PROCTOR_VIOLATION_GRACE_MS - elapsed) / 1000))
      setStatusText(remaining > 0 ? `${check.message} ${remaining} soniya ichida tuzating.` : check.message)

      if (elapsed >= PROCTOR_VIOLATION_GRACE_MS && consecutiveViolationsRef.current >= 3) {
        if (!warningConfirmationRef.current) {
          warningConfirmationRef.current = true
          setStatusText('Holat yana bir marta tekshirilmoqda...')
        } else {
          showWarning(check.message)
        }
      }
    } catch (reason) {
      if (!activeRef.current) return
      setStatus('error')
      setStatusText(reason instanceof Error ? reason.message : 'Yuz nazoratini tekshirishda xato')
    } finally {
      detectingRef.current = false
    }
  }, [showWarning])

  useEffect(() => {
    activeRef.current = true
    let intervalId: number | null = null

    void (async () => {
      try {
        await prepareProctorEngine()
        const stream = await openCameraStream(props.cameraDeviceId, 640, 480)
        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setStatus('ok')
        setStatusText('Yuz va nigoh to‘g‘ri. Nazorat faol.')
        void runCheck()
        intervalId = window.setInterval(() => void runCheck(), PROCTOR_CHECK_INTERVAL_MS)
      } catch (reason) {
        if (!activeRef.current) return
        setStatus('error')
        setStatusText(reason instanceof Error ? reason.message : 'Kamerani ishga tushirib bo‘lmadi')
      }
    })()

    return () => {
      activeRef.current = false
      if (intervalId) window.clearInterval(intervalId)
      clearModalTimer()
      if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current)
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [props.cameraDeviceId, runCheck])

  return (
    <>
      <div className={`proctor-widget ${status}`}>
        <div className="proctor-copy">
          <strong>Yuz nazorati</strong>
          <span>{statusText}</span>
        </div>
        <div className="proctor-camera">
          <video ref={videoRef} autoPlay muted playsInline />
          <div className="proctor-warning-count">{warningCount}/{PROCTOR_MAX_WARNINGS}</div>
        </div>
      </div>

      {warningModal && (
        <div className="proctor-modal-backdrop">
          <section className={warningModal.final ? 'proctor-modal final' : 'proctor-modal'}>
            <div className="proctor-modal-mark">{warningModal.final ? '!' : warningModal.count}</div>
            <span className="eyebrow">OGOHLANTIRISH {warningModal.count}/{PROCTOR_MAX_WARNINGS}</span>
            <h2>{warningModal.final ? 'Test yakunlanmoqda' : 'Yuz nazorati buzildi'}</h2>
            <p>{warningModal.message}</p>
            {!warningModal.final && (
              <button className="connect-button compact" onClick={() => setWarningModal(null)}>
                Tushunarli
              </button>
            )}
          </section>
        </div>
      )}
    </>
  )
}

function ExamScreen(props: {
  exam: ExamSession
  questionIndex: number
  answers: Record<string, number>
  secondsLeft: number
  connected: boolean
  cameraDeviceId: string
  onAnswer: (index: number) => void
  onQuestion: (index: number) => void
  onSubmit: () => void
}): React.JSX.Element {
  const question = props.exam.test.questions[props.questionIndex]
  const answered = Object.keys(props.answers).length
  const progress = (answered / props.exam.test.questions.length) * 100
  const minutes = Math.floor(props.secondsLeft / 60)
  const seconds = props.secondsLeft % 60
  return (
    <div className="exam-page">
      <header className="exam-header">
        <div className="exam-brand"><img className="exam-brand-logo" src="/branding/logo.png" alt="Easy Testing Student" /><div><strong>Easy Testing Student</strong><span>{props.exam.test.title}</span></div></div>
        <div className="exam-status"><span className={props.connected ? 'network online-net' : 'network offline-net'}>● {props.connected ? 'Serverga ulangan' : 'Oflayn — javoblar saqlanmoqda'}</span><div className={props.secondsLeft <= 120 ? 'timer warning' : 'timer'}><small>Qolgan vaqt</small><strong>{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</strong></div></div>
      </header>
      <div className="progress-line"><div style={{ width: `${progress}%` }} /></div>
      <main className="exam-layout">
        <aside className="question-nav">
          <ProctorCamera cameraDeviceId={props.cameraDeviceId} onTerminate={props.onSubmit} />
          <div className="proctor-divider" />
          <div className="question-nav-heading"><h3>Savollar</h3><span>{answered}/{props.exam.test.questions.length}</span></div>
          <div className="question-numbers">
            {props.exam.test.questions.map((item, index) => (
              <button key={item.id} className={`${index === props.questionIndex ? 'current ' : ''}${props.answers[item.id] !== undefined ? 'answered' : ''}`} onClick={() => props.onQuestion(index)}>{index + 1}</button>
            ))}
          </div>
          <div className="legend"><span><i className="answered" /> Javob berilgan</span><span><i /> Javobsiz</span></div>
        </aside>
        <section className="question-area">
          <div className="question-card">
            <div className="question-title"><span>SAVOL {props.questionIndex + 1}</span><small>4 ta variantdan birini tanlang</small></div>
            <h1>{question.text}</h1>
            <div className="answer-list">
              {question.options.map((option, index) => (
                <button className={props.answers[question.id] === index ? 'selected' : ''} key={index} onClick={() => props.onAnswer(index)}>
                  <b>{String.fromCharCode(65 + index)}</b><span>{option}</span><i>{props.answers[question.id] === index ? '✓' : ''}</i>
                </button>
              ))}
            </div>
          </div>
          <div className="exam-footer">
            <button className="previous" disabled={props.questionIndex === 0} onClick={() => props.onQuestion(props.questionIndex - 1)}>← Oldingi</button>
            {props.questionIndex < props.exam.test.questions.length - 1
              ? <button className="next" onClick={() => props.onQuestion(props.questionIndex + 1)}>Keyingi →</button>
              : <button className="finish" onClick={props.onSubmit}>Testni yakunlash</button>}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
