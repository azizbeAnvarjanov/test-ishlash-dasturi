type FaceWorkerTask = 'prepare-identity' | 'prepare-proctor' | 'identity' | 'proctor'
type FaceWorkerResult = {
  faceCount: number
  embedding?: number[]
  boxScore?: number
  confidence?: number
  yaw?: number
  pitch?: number
  roll?: number
  gazeStrength?: number
  landmarkTurnRatio?: number
}

let faceWorker: Worker | null = null
let taskId = 0
const pendingTasks = new Map<number, {
  resolve: (result: FaceWorkerResult | undefined) => void
  reject: (reason: Error) => void
}>()
const inferenceCanvas = document.createElement('canvas')
const modelBasePath = new URL('./models/', window.location.href).href

const captureVideoFrame = (video: HTMLVideoElement, maxWidth: number): ImageData => {
  const sourceWidth = video.videoWidth || 640
  const sourceHeight = video.videoHeight || 480
  const scale = Math.min(1, maxWidth / sourceWidth)
  inferenceCanvas.width = Math.max(1, Math.round(sourceWidth * scale))
  inferenceCanvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = inferenceCanvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Kamera kadrini tayyorlab bo\u2018lmadi')
  context.drawImage(video, 0, 0, inferenceCanvas.width, inferenceCanvas.height)
  return context.getImageData(0, 0, inferenceCanvas.width, inferenceCanvas.height)
}

const getFaceWorker = (): Worker => {
  if (faceWorker) return faceWorker
  faceWorker = new Worker(new URL('./face-worker.ts', import.meta.url), { type: 'module' })
  faceWorker.onmessage = (event: MessageEvent<{
    id: number
    ok: boolean
    result?: FaceWorkerResult
    error?: string
  }>) => {
    const pending = pendingTasks.get(event.data.id)
    if (!pending) return
    pendingTasks.delete(event.data.id)
    if (event.data.ok) pending.resolve(event.data.result)
    else pending.reject(new Error(event.data.error || 'Yuz modelida xato'))
  }
  faceWorker.onerror = () => {
    for (const pending of pendingTasks.values()) pending.reject(new Error('Yuz modeli ishga tushmadi'))
    pendingTasks.clear()
    faceWorker?.terminate()
    faceWorker = null
  }
  return faceWorker
}

const runFaceTask = (task: FaceWorkerTask, image?: ImageData): Promise<FaceWorkerResult | undefined> => {
  const id = ++taskId
  return new Promise((resolve, reject) => {
    pendingTasks.set(id, { resolve, reject })
    if (image) {
      getFaceWorker().postMessage({
        id,
        task,
        modelBasePath,
        image: image.data.buffer,
        width: image.width,
        height: image.height
      }, [image.data.buffer])
    } else {
      getFaceWorker().postMessage({ id, task, modelBasePath })
    }
  })
}

let readyPromise: Promise<void> | null = null
let proctorReadyPromise: Promise<void> | null = null

export type ProctorFaceCheck = {
  ok: boolean
  reason: 'ok' | 'no-face' | 'multiple-faces' | 'turned-away' | 'looking-away' | 'low-confidence'
  message: string
  faceCount: number
  metrics?: {
    yawDegrees?: number
    pitchDegrees?: number
    rollDegrees?: number
    gazeStrength?: number
    landmarkTurnRatio?: number
  }
}

export const prepareFaceEngine = (): Promise<void> => {
  if (!readyPromise) {
    readyPromise = runFaceTask('prepare-identity').then(() => undefined).catch((reason) => {
      readyPromise = null
      throw reason
    })
  }
  return readyPromise
}

export const prepareProctorEngine = (): Promise<void> => {
  if (!proctorReadyPromise) {
    proctorReadyPromise = runFaceTask('prepare-proctor').then(() => undefined).catch((reason) => {
      proctorReadyPromise = null
      throw reason
    })
  }
  return proctorReadyPromise
}

export const extractFaceDescriptor = async (
  input: HTMLVideoElement | HTMLImageElement
): Promise<number[]> => {
  if (!(input instanceof HTMLVideoElement)) throw new Error('Yuzni kamera orqali skanerlang')
  await prepareFaceEngine()
  const result = await runFaceTask('identity', captureVideoFrame(input, 384))
  if (!result || result.faceCount === 0) throw new Error('Kamerada yuz topilmadi. Kameraga to‘g‘ri qarang.')
  if (result.faceCount > 1) throw new Error('Kamerada faqat bitta odam bo‘lishi kerak.')
  if (!result.embedding || result.embedding.length < 64) {
    throw new Error('Yuz shablonini yaratib bo‘lmadi. Kameraga to‘g‘ri qarab qayta urinib ko‘ring.')
  }
  if (Number.isFinite(result.boxScore) && result.boxScore! < 0.3) {
    throw new Error('Yuz kamerada juda kichik ko‘rindi. Kameraga biroz yaqinroq turing.')
  }
  return result.embedding.map((value) => Number(value.toFixed(6)))
}

const radiansToDegrees = (value: number): number => Math.abs(Math.round((value * 180) / Math.PI))
// Oddiy tabiiy harakatlar ogohlantirish bermaydi, aniq yon tomonga qarash esa aniqlanadi.
const PROCTOR_YAW_LIMIT_DEGREES = 22
const PROCTOR_PITCH_LIMIT_DEGREES = 24
const PROCTOR_ROLL_LIMIT_DEGREES = 28
const PROCTOR_GAZE_STRENGTH_LIMIT = 0.12
const PROCTOR_LANDMARK_TURN_LIMIT = 0.22

export const detectProctorFace = async (input: HTMLVideoElement): Promise<ProctorFaceCheck> => {
  await prepareProctorEngine()
  const result = await runFaceTask('proctor', captureVideoFrame(input, 256))
  if (!result) throw new Error('Yuz nazorati natijasi olinmadi')
  const faceCount = result.faceCount

  if (faceCount === 0) {
    return {
      ok: false,
      reason: 'no-face',
      message: 'Yuz kamerada ko‘rinmayapti. Kameraga qayting.',
      faceCount
    }
  }

  if (faceCount > 1) {
    return {
      ok: false,
      reason: 'multiple-faces',
      message: 'Kamerada bittadan ortiq yuz ko‘rindi.',
      faceCount
    }
  }

  const confidence = result.confidence || 0
  if (confidence < 0.28) {
    return {
      ok: false,
      reason: 'low-confidence',
      message: 'Yuz aniq ko‘rinmayapti. Yorug‘likni yaxshilang yoki kameraga yaqinroq turing.',
      faceCount
    }
  }

  const gazeStrength = result.gazeStrength
  const yawDegrees = result.yaw !== undefined ? radiansToDegrees(result.yaw) : undefined
  const pitchDegrees = result.pitch !== undefined ? radiansToDegrees(result.pitch) : undefined
  const rollDegrees = result.roll !== undefined ? radiansToDegrees(result.roll) : undefined
  const landmarkTurnRatio = result.landmarkTurnRatio
  const turnedAway =
    (yawDegrees !== undefined && yawDegrees > PROCTOR_YAW_LIMIT_DEGREES) ||
    (pitchDegrees !== undefined && pitchDegrees > PROCTOR_PITCH_LIMIT_DEGREES) ||
    (rollDegrees !== undefined && rollDegrees > PROCTOR_ROLL_LIMIT_DEGREES) ||
    (landmarkTurnRatio !== undefined && landmarkTurnRatio > PROCTOR_LANDMARK_TURN_LIMIT)

  if (turnedAway) {
    return {
      ok: false,
      reason: 'turned-away',
      message: 'Boshingizni yon tomonga burdingiz. Kameraga to‘g‘ri qarang.',
      faceCount,
      metrics: { yawDegrees, pitchDegrees, rollDegrees, gazeStrength, landmarkTurnRatio }
    }
  }

  if (gazeStrength !== undefined && gazeStrength > PROCTOR_GAZE_STRENGTH_LIMIT) {
    return {
      ok: false,
      reason: 'looking-away',
      message: 'Nigohingiz yon tomonga qaratildi. Ekran va kameraga to‘g‘ri qarang.',
      faceCount,
      metrics: { yawDegrees, pitchDegrees, rollDegrees, gazeStrength, landmarkTurnRatio }
    }
  }

  return {
    ok: true,
    reason: 'ok',
    message: 'Yuz va nigoh kameraga to‘g‘ri qaragan.',
    faceCount,
    metrics: { yawDegrees, pitchDegrees, rollDegrees, gazeStrength, landmarkTurnRatio }
  }
}

export const captureVideoPhoto = (video: HTMLVideoElement): string => {
  const canvas = document.createElement('canvas')
  const sourceWidth = video.videoWidth || 640
  const sourceHeight = video.videoHeight || 480
  const scale = Math.min(1, 640 / sourceWidth)
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Kamera rasmini olishda xato')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.72)
}
