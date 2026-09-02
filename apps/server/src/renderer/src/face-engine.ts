import { Human } from '@vladmandic/human'

const human = new Human({
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
    description: { enabled: true },
    antispoof: { enabled: false },
    liveness: { enabled: false }
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false }
})

let readyPromise: Promise<void> | null = null
const inferenceCanvas = document.createElement('canvas')

const scaledImage = (image: HTMLImageElement): HTMLCanvasElement => {
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const scale = Math.min(1, 640 / Math.max(1, sourceWidth))
  inferenceCanvas.width = Math.max(1, Math.round(sourceWidth * scale))
  inferenceCanvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = inferenceCanvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Rasmni tekshirishga tayyorlab bo\u2018lmadi')
  context.drawImage(image, 0, 0, inferenceCanvas.width, inferenceCanvas.height)
  return inferenceCanvas
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => {
  requestAnimationFrame(() => window.setTimeout(resolve, 0))
})

export const prepareFaceEngine = (): Promise<void> => {
  if (!readyPromise) {
    readyPromise = (async () => {
      await human.load()
      await human.warmup()
    })()
  }
  return readyPromise
}

export const extractFaceFromDataUrl = async (dataUrl: string): Promise<number[]> => {
  await prepareFaceEngine()
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Rasmni ochib bo‘lmadi'))
    image.src = dataUrl
  })
  await yieldToUi()
  const result = await human.detect(scaledImage(image))
  if (result.face.length === 0) throw new Error('Rasmda yuz topilmadi')
  if (result.face.length > 1) throw new Error('Rasmda faqat bitta yuz bo‘lishi kerak')
  const face = result.face[0]
  if (!face.embedding || face.embedding.length < 64) {
    throw new Error('Rasmdagi yuz shablonini yaratib bo‘lmadi')
  }
  if (Number.isFinite(face.boxScore) && face.boxScore < 0.3) {
    throw new Error('Rasmdagi yuz juda kichik ko‘rinadi')
  }
  return face.embedding.map((value) => Number(value.toFixed(6)))
}
