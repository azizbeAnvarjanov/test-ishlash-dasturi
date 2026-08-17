/// <reference lib="webworker" />

import { Human, type FaceResult, type Point } from '@vladmandic/human'

type WorkerRequest = {
  id: number
  task: 'prepare-identity' | 'prepare-proctor' | 'identity' | 'proctor'
  modelBasePath: string
  image?: ArrayBuffer
  width?: number
  height?: number
}

type SimplePoint = { x: number; y: number }

const scope = self as unknown as DedicatedWorkerGlobalScope
let identityHuman: Human | null = null
let proctorHuman: Human | null = null
let identityReady: Promise<void> | null = null
let proctorReady: Promise<void> | null = null

const createIdentityHuman = (modelBasePath: string): Human => new Human({
  // HumanGL WebWorker ichidagi inference uchun optimallashtirilgan. Oddiy
  // WebGL ayrim eski Intel/AMD qurilmalarda software shaderga tushib qoladi.
  backend: 'humangl',
  modelBasePath,
  cacheSensitivity: 0,
  warmup: 'none',
  debug: false,
  filter: { enabled: false },
  face: {
    enabled: true,
    detector: { rotation: false, return: false, maxDetected: 2, minConfidence: 0.2 },
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

const createProctorHuman = (modelBasePath: string): Human => new Human({
  backend: 'humangl',
  modelBasePath,
  cacheSensitivity: 0,
  warmup: 'none',
  debug: false,
  filter: { enabled: false },
  face: {
    enabled: true,
    detector: { rotation: true, return: false, maxDetected: 2, minConfidence: 0.35 },
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

const prepareIdentity = (modelBasePath: string): Promise<void> => {
  if (!identityReady) {
    identityHuman = createIdentityHuman(modelBasePath)
    identityReady = identityHuman.load().then(() => identityHuman!.warmup()).then(() => undefined)
  }
  return identityReady
}

const prepareProctor = (modelBasePath: string): Promise<void> => {
  if (!proctorReady) {
    proctorHuman = createProctorHuman(modelBasePath)
    proctorReady = proctorHuman.load().then(() => proctorHuman!.warmup()).then(() => undefined)
  }
  return proctorReady
}

const averagePoint = (points: Point[] | undefined): SimplePoint | null => {
  if (!points?.length) return null
  return {
    x: points.reduce((sum, point) => sum + point[0], 0) / points.length,
    y: points.reduce((sum, point) => sum + point[1], 0) / points.length
  }
}

const annotationPoint = (face: FaceResult, names: string[]): SimplePoint | null => {
  const annotations = face.annotations as Record<string, Point[] | undefined>
  for (const name of names) {
    const point = averagePoint(annotations[name])
    if (point) return point
  }
  return null
}

const distance = (first: SimplePoint, second: SimplePoint): number =>
  Math.hypot(first.x - second.x, first.y - second.y)

const landmarkTurnRatio = (face: FaceResult): number | undefined => {
  const leftEye = annotationPoint(face, ['leftEye'])
  const rightEye = annotationPoint(face, ['rightEye'])
  const nose = annotationPoint(face, ['noseTip', 'nose', 'noseBottom'])
  if (!leftEye || !rightEye || !nose) return undefined
  const left = distance(nose, leftEye)
  const right = distance(nose, rightEye)
  return Math.abs(left - right) / Math.max(0.0001, left + right)
}

const imageFromRequest = (request: WorkerRequest): ImageData => {
  if (!request.image || !request.width || !request.height) throw new Error('Kamera kadri olinmadi')
  return new ImageData(new Uint8ClampedArray(request.image), request.width, request.height)
}

const handleRequest = async (request: WorkerRequest): Promise<void> => {
  if (request.task === 'prepare-identity') {
    await prepareIdentity(request.modelBasePath)
    scope.postMessage({ id: request.id, ok: true })
    return
  }
  if (request.task === 'prepare-proctor') {
    await prepareProctor(request.modelBasePath)
    scope.postMessage({ id: request.id, ok: true })
    return
  }

  const image = imageFromRequest(request)
  if (request.task === 'identity') {
    await prepareIdentity(request.modelBasePath)
    const result = await identityHuman!.detect(image)
    const face = result.face[0]
    scope.postMessage({
      id: request.id,
      ok: true,
      result: {
        faceCount: result.face.length,
        embedding: face?.embedding,
        boxScore: face?.boxScore
      }
    })
    return
  }

  await prepareProctor(request.modelBasePath)
  const result = await proctorHuman!.detect(image)
  const face = result.face[0]
  scope.postMessage({
    id: request.id,
    ok: true,
    result: {
      faceCount: result.face.length,
      confidence: face ? face.faceScore || face.boxScore || face.score || 0 : 0,
      yaw: face?.rotation?.angle.yaw,
      pitch: face?.rotation?.angle.pitch,
      roll: face?.rotation?.angle.roll,
      gazeStrength: face?.rotation?.gaze.strength,
      landmarkTurnRatio: face ? landmarkTurnRatio(face) : undefined
    }
  })
}

let queue = Promise.resolve()
scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data
  queue = queue.then(() => handleRequest(request)).catch((reason: unknown) => {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: reason instanceof Error ? reason.message : 'Yuz modelida noma\u2018lum xato'
    })
  })
}

export {}
