import { Human, type FaceResult, type Point } from '@vladmandic/human'

const faceIdentityHuman = new Human({
  backend: 'webgl',
  modelBasePath: './models',
  cacheSensitivity: 0,
  warmup: 'none',
  debug: false,
  face: {
    enabled: true,
    detector: { rotation: false, return: false, maxDetected: 2, minConfidence: 0.2 },
    // Face ID uchun embedding yetarli. Mesh va iris past quvvatli
    // kompyuterlarda katta qo'shimcha yuk bo'lib, natijaga ta'sir qilmaydi.
    mesh: { enabled: false },
    iris: { enabled: false },
    emotion: { enabled: false },
    description: { enabled: true },
    antispoof: { enabled: false },
    liveness: { enabled: false }
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false }
})

const proctorHuman = new Human({
  backend: 'webgl',
  modelBasePath: './models',
  cacheSensitivity: 0,
  warmup: 'none',
  debug: false,
  face: {
    enabled: true,
    detector: { rotation: false, return: false, maxDetected: 2, minConfidence: 0.35 },
    mesh: { enabled: false },
    iris: { enabled: false },
    emotion: { enabled: false },
    description: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false }
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false }
})

let readyPromise: Promise<void> | null = null
let proctorReadyPromise: Promise<void> | null = null
const inferenceCanvas = document.createElement('canvas')

const scaledVideoFrame = (video: HTMLVideoElement, maxWidth: number): HTMLCanvasElement => {
  const sourceWidth = video.videoWidth || 640
  const sourceHeight = video.videoHeight || 480
  const scale = Math.min(1, maxWidth / sourceWidth)
  inferenceCanvas.width = Math.max(1, Math.round(sourceWidth * scale))
  inferenceCanvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = inferenceCanvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Kamera kadrini tayyorlab bo\u2018lmadi')
  context.drawImage(video, 0, 0, inferenceCanvas.width, inferenceCanvas.height)
  return inferenceCanvas
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => {
  requestAnimationFrame(() => window.setTimeout(resolve, 0))
})

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
    readyPromise = (async () => {
      await faceIdentityHuman.load()
      await faceIdentityHuman.warmup()
    })()
  }
  return readyPromise
}

export const prepareProctorEngine = (): Promise<void> => {
  if (!proctorReadyPromise) {
    proctorReadyPromise = (async () => {
      await proctorHuman.load()
      await proctorHuman.warmup()
    })()
  }
  return proctorReadyPromise
}

export const extractFaceDescriptor = async (
  input: HTMLVideoElement | HTMLImageElement
): Promise<number[]> => {
  await prepareFaceEngine()
  await yieldToUi()
  const detectionInput = input instanceof HTMLVideoElement ? scaledVideoFrame(input, 480) : input
  const result = await faceIdentityHuman.detect(detectionInput)
  if (result.face.length === 0) throw new Error('Kamerada yuz topilmadi. Kameraga to‘g‘ri qarang.')
  if (result.face.length > 1) throw new Error('Kamerada faqat bitta odam bo‘lishi kerak.')
  const face = result.face[0]
  if (!face.embedding || face.embedding.length < 64) {
    throw new Error('Yuz shablonini yaratib bo‘lmadi. Kameraga to‘g‘ri qarab qayta urinib ko‘ring.')
  }
  if (Number.isFinite(face.boxScore) && face.boxScore < 0.3) {
    throw new Error('Yuz kamerada juda kichik ko‘rindi. Kameraga biroz yaqinroq turing.')
  }
  return face.embedding.map((value) => Number(value.toFixed(6)))
}

const radiansToDegrees = (value: number): number => Math.abs(Math.round((value * 180) / Math.PI))
// Oddiy tabiiy harakatlar ogohlantirish bermaydi, aniq yon tomonga qarash esa aniqlanadi.
const PROCTOR_YAW_LIMIT_DEGREES = 15
const PROCTOR_PITCH_LIMIT_DEGREES = 18
const PROCTOR_ROLL_LIMIT_DEGREES = 22
const PROCTOR_GAZE_STRENGTH_LIMIT = 0.075
const PROCTOR_LANDMARK_TURN_LIMIT = 0.16

type SimplePoint = { x: number; y: number }

const averageAnnotationPoint = (points: Point[] | undefined): SimplePoint | null => {
  if (!points?.length) return null
  return {
    x: points.reduce((sum, point) => sum + point[0], 0) / points.length,
    y: points.reduce((sum, point) => sum + point[1], 0) / points.length
  }
}

const annotationPoint = (face: FaceResult, names: string[]): SimplePoint | null => {
  const annotations = face.annotations as Record<string, Point[] | undefined>
  for (const name of names) {
    const point = averageAnnotationPoint(annotations[name])
    if (point) return point
  }
  return null
}

const pointDistance = (first: SimplePoint, second: SimplePoint): number =>
  Math.hypot(first.x - second.x, first.y - second.y)

// Yuz to'liq yonga burilganda ayrim qurilmalarda 3D yaw nolga yaqin chiqadi.
// Burunning ikki ko'z va ikki yonoqqa masofa nosimmetriyasi buni mustaqil ushlaydi.
const getLandmarkTurnRatio = (face: FaceResult): number | undefined => {
  const leftEye = annotationPoint(face, ['leftEye'])
  const rightEye = annotationPoint(face, ['rightEye'])
  const nose = annotationPoint(face, ['noseTip', 'nose', 'noseBottom'])
  if (!leftEye || !rightEye || !nose) return undefined

  const leftEyeDistance = pointDistance(nose, leftEye)
  const rightEyeDistance = pointDistance(nose, rightEye)
  const eyeAsymmetry = Math.abs(leftEyeDistance - rightEyeDistance) /
    Math.max(0.0001, leftEyeDistance + rightEyeDistance)

  const leftCheek = annotationPoint(face, ['leftCheek', 'leftEar'])
  const rightCheek = annotationPoint(face, ['rightCheek', 'rightEar'])
  if (!leftCheek || !rightCheek) return eyeAsymmetry

  const leftCheekDistance = pointDistance(nose, leftCheek)
  const rightCheekDistance = pointDistance(nose, rightCheek)
  const cheekAsymmetry = Math.abs(leftCheekDistance - rightCheekDistance) /
    Math.max(0.0001, leftCheekDistance + rightCheekDistance)
  return Math.max(eyeAsymmetry, cheekAsymmetry)
}

export const detectProctorFace = async (input: HTMLVideoElement): Promise<ProctorFaceCheck> => {
  await prepareProctorEngine()
  const result = await proctorHuman.detect(scaledVideoFrame(input, 320))
  const faceCount = result.face.length

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

  const face = result.face[0]
  const confidence = face.faceScore || face.boxScore || face.score || 0
  if (confidence < 0.28) {
    return {
      ok: false,
      reason: 'low-confidence',
      message: 'Yuz aniq ko‘rinmayapti. Yorug‘likni yaxshilang yoki kameraga yaqinroq turing.',
      faceCount
    }
  }

  const rotation = face.rotation?.angle
  const gazeStrength = face.rotation?.gaze.strength
  const yawDegrees = rotation ? radiansToDegrees(rotation.yaw) : undefined
  const pitchDegrees = rotation ? radiansToDegrees(rotation.pitch) : undefined
  const rollDegrees = rotation ? radiansToDegrees(rotation.roll) : undefined
  const landmarkTurnRatio = getLandmarkTurnRatio(face)
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
