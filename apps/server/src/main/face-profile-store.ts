import fs from 'node:fs'
import path from 'node:path'
import type { FaceProfile, StudentRosterEntry } from '@test/shared'

type StoredFaceProfile = StudentRosterEntry & {
  descriptor: number[]
  photoFile?: string
}

type FaceDatabaseFile = {
  format: 'test-ishlash-dasturi-face-id'
  version: 1
  updatedAt: string
  profiles: StoredFaceProfile[]
}

const INDEX_FILE_NAME = 'Face ID baza.json'
const README_FILE_NAME = 'README - Face ID baza.txt'

const safePhotoName = (value: string): string =>
  value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100) || 'Talaba'

const parsePhoto = (dataUrl?: string): { extension: 'jpg' | 'png'; bytes: Buffer } | null => {
  if (!dataUrl) return null
  const match = /^data:image\/(jpeg|jpg|png);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl)
  if (!match) return null
  return {
    extension: match[1].toLocaleLowerCase('en-US') === 'png' ? 'png' : 'jpg',
    bytes: Buffer.from(match[2], 'base64')
  }
}

export class FaceProfileStore {
  constructor(private readonly getDirectoryPath: () => string) {}

  getDirectory(): string {
    return this.getDirectoryPath().trim()
  }

  getIndexPath(): string {
    const directory = this.getDirectory()
    return directory ? path.join(directory, INDEX_FILE_NAME) : ''
  }

  listProfiles(): FaceProfile[] {
    return this.readDatabase().profiles.map((profile) => ({
      id: profile.id,
      fish: profile.fish,
      group: profile.group,
      descriptor: profile.descriptor
    }))
  }

  listRoster(): StudentRosterEntry[] {
    return this.readDatabase().profiles.map(({ id, fish, group }) => ({ id, fish, group }))
  }

  replaceProfiles(profiles: FaceProfile[]): number {
    const directory = this.ensureDirectory()
    const previous = this.readDatabase().profiles
    const usedFileNames = new Set<string>()
    const storedProfiles = profiles.map((profile) =>
      this.writeProfilePhoto(directory, profile, usedFileNames)
    )

    const retainedFiles = new Set(storedProfiles.flatMap((profile) => profile.photoFile ? [profile.photoFile] : []))
    for (const profile of previous) {
      if (profile.photoFile && !retainedFiles.has(profile.photoFile)) {
        this.removeManagedPhoto(directory, profile.photoFile)
      }
    }

    this.writeDatabase(directory, storedProfiles)
    return storedProfiles.length
  }

  upsertProfile(profile: FaceProfile): void {
    const directory = this.ensureDirectory()
    const profiles = this.readDatabase().profiles
    const existingIndex = profiles.findIndex((item) => item.id === profile.id)
    const usedFileNames = new Set(
      profiles.flatMap((item, index) => index !== existingIndex && item.photoFile ? [item.photoFile] : [])
    )
    const stored = this.writeProfilePhoto(directory, profile, usedFileNames, existingIndex >= 0 ? profiles[existingIndex] : undefined)

    if (existingIndex >= 0) {
      const previousPhoto = profiles[existingIndex].photoFile
      profiles[existingIndex] = stored
      if (previousPhoto && previousPhoto !== stored.photoFile) this.removeManagedPhoto(directory, previousPhoto)
    } else {
      profiles.push(stored)
    }
    this.writeDatabase(directory, profiles)
  }

  deleteProfile(id: string): boolean {
    const directory = this.ensureDirectory()
    const profiles = this.readDatabase().profiles
    const profile = profiles.find((item) => item.id === id)
    if (!profile) return false
    if (profile.photoFile) this.removeManagedPhoto(directory, profile.photoFile)
    this.writeDatabase(directory, profiles.filter((item) => item.id !== id))
    return true
  }

  private emptyDatabase(): FaceDatabaseFile {
    return {
      format: 'test-ishlash-dasturi-face-id',
      version: 1,
      updatedAt: new Date().toISOString(),
      profiles: []
    }
  }

  private readDatabase(): FaceDatabaseFile {
    const indexPath = this.getIndexPath()
    if (!indexPath || !fs.existsSync(indexPath)) return this.emptyDatabase()
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Partial<FaceDatabaseFile>
      const profiles = Array.isArray(raw.profiles) ? raw.profiles.flatMap((profile) => {
        const item = profile as Partial<StoredFaceProfile>
        const descriptor = Array.isArray(item.descriptor) ? item.descriptor.map(Number) : []
        if (!item.id || !item.fish || !item.group || descriptor.length < 64 || descriptor.some((value) => !Number.isFinite(value))) {
          return []
        }
        return [{
          id: String(item.id),
          fish: String(item.fish),
          group: String(item.group),
          descriptor,
          photoFile: item.photoFile ? path.basename(String(item.photoFile)) : undefined
        }]
      }) : []
      return {
        format: 'test-ishlash-dasturi-face-id',
        version: 1,
        updatedAt: String(raw.updatedAt || new Date().toISOString()),
        profiles
      }
    } catch {
      throw new Error(`Face ID baza fayli buzilgan: ${indexPath}`)
    }
  }

  private ensureDirectory(): string {
    const directory = this.getDirectory()
    if (!directory) {
      throw new Error('Server sozlamasida Face ID rasmlari saqlanadigan papkani tanlang')
    }
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }

  private writeProfilePhoto(
    directory: string,
    profile: FaceProfile,
    usedFileNames: Set<string>,
    existing?: StoredFaceProfile
  ): StoredFaceProfile {
    const photo = parsePhoto(profile.photoDataUrl)
    let photoFile = existing?.photoFile
    if (photo) {
      const existingExtension = existing?.photoFile ? path.extname(existing.photoFile).slice(1).toLocaleLowerCase('en-US') : ''
      if (!photoFile || existingExtension !== photo.extension || usedFileNames.has(photoFile)) {
        photoFile = this.uniquePhotoFileName(profile.fish, profile.group, photo.extension, usedFileNames)
      }
      fs.writeFileSync(path.join(directory, photoFile), photo.bytes)
    }
    if (photoFile) usedFileNames.add(photoFile)
    return {
      id: profile.id,
      fish: profile.fish,
      group: profile.group,
      descriptor: profile.descriptor,
      photoFile
    }
  }

  private uniquePhotoFileName(
    fish: string,
    group: string,
    extension: 'jpg' | 'png',
    usedFileNames: Set<string>
  ): string {
    const baseName = safePhotoName(fish)
    let candidate = `${baseName}.${extension}`
    if (!usedFileNames.has(candidate)) return candidate

    const groupName = safePhotoName(group)
    candidate = `${baseName} - ${groupName}.${extension}`
    if (!usedFileNames.has(candidate)) return candidate

    let suffix = 2
    while (usedFileNames.has(`${baseName} - ${groupName} (${suffix}).${extension}`)) suffix += 1
    return `${baseName} - ${groupName} (${suffix}).${extension}`
  }

  private writeDatabase(directory: string, profiles: StoredFaceProfile[]): void {
    const database: FaceDatabaseFile = {
      format: 'test-ishlash-dasturi-face-id',
      version: 1,
      updatedAt: new Date().toISOString(),
      profiles: [...profiles].sort((first, second) =>
        first.group.localeCompare(second.group, 'uz') || first.fish.localeCompare(second.fish, 'uz')
      )
    }
    const indexPath = path.join(directory, INDEX_FILE_NAME)
    const temporaryPath = `${indexPath}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2), 'utf8')
    if (fs.existsSync(indexPath)) fs.rmSync(indexPath)
    fs.renameSync(temporaryPath, indexPath)

    const readmePath = path.join(directory, README_FILE_NAME)
    fs.writeFileSync(readmePath, [
      'Bu papka Test Server V9 Face ID bazasi uchun ishlatiladi.',
      'Talabalar rasmlari F.I.Sh nomi bilan saqlanadi.',
      `"${INDEX_FILE_NAME}" faylini qo'lda o'zgartirmang.`,
      'Papka va fayllarni zaxiralab turish tavsiya etiladi.'
    ].join('\r\n'), 'utf8')
  }

  private removeManagedPhoto(directory: string, fileName: string): void {
    const safeName = path.basename(fileName)
    if (!/\.(jpe?g|png)$/i.test(safeName)) return
    const filePath = path.join(directory, safeName)
    if (fs.existsSync(filePath)) fs.rmSync(filePath)
  }
}
