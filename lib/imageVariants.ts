/**
 * Browser-side preparation of images for the PHP admin endpoints.
 *
 *   createImageVariants()     POST /api/admin/photos/upload: one decode, two WebP variants
 *     full       max 2000 × 2000, quality 0.84 (same as the current admin upload)
 *     thumbnail  max  600 ×  600, quality 0.80
 *
 *   createHeroImageVariant()  POST /api/admin/hero/upload: one WebP
 *     hero       max 2560 × 2560, quality 0.88 (same as the current hero upload)
 *
 * Aspect ratio is kept and small images are never upscaled. The server
 * checks every file against exactly these limits.
 *
 * Not used by the current admin yet; it still uses compressImage().
 */

export const FULL_MAX_DIMENSION = 2000
export const THUMB_MAX_DIMENSION = 600
export const HERO_MAX_DIMENSION = 2560
export const FULL_QUALITY = 0.84
export const THUMB_QUALITY = 0.8
export const HERO_QUALITY = 0.88

export type ImageVariants = {
  full: File
  thumbnail: File
  /** Dimensions of the full variant. */
  width: number
  height: number
}

export type HeroImageVariant = {
  file: File
  width: number
  height: number
}

/** Thrown when the browser cannot produce WebP (some older Safari versions). */
export class WebpEncodingUnsupportedError extends Error {
  constructor() {
    super('Den här webbläsaren kan inte skapa WebP-bilder.')
    this.name = 'WebpEncodingUnsupportedError'
  }
}

export async function createImageVariants(file: File): Promise<ImageVariants> {
  const bitmap = await decode(file)

  try {
    const baseName = baseNameOf(file)
    const full = await renderWebp(bitmap, FULL_MAX_DIMENSION, FULL_QUALITY, `${baseName}.webp`)
    const thumbnail = await renderWebp(bitmap, THUMB_MAX_DIMENSION, THUMB_QUALITY, `${baseName}-thumb.webp`)

    return { full: full.file, thumbnail: thumbnail.file, width: full.width, height: full.height }
  } finally {
    bitmap.close()
  }
}

export async function createHeroImageVariant(file: File): Promise<HeroImageVariant> {
  const bitmap = await decode(file)

  try {
    return await renderWebp(bitmap, HERO_MAX_DIMENSION, HERO_QUALITY, `${baseNameOf(file)}.webp`)
  } finally {
    bitmap.close()
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not an image`)
  }

  return createImageBitmap(file)
}

function baseNameOf(file: File): string {
  return file.name.replace(/\.[^/.]+$/, '') || 'photo'
}

async function renderWebp(
  bitmap: ImageBitmap,
  maxDimension: number,
  quality: number,
  name: string
): Promise<{ file: File; width: number; height: number }> {
  const scale = Math.min(maxDimension / bitmap.width, maxDimension / bitmap.height, 1)
  // Never exceed the limit through rounding.
  const width = Math.min(maxDimension, Math.max(1, Math.round(bitmap.width * scale)))
  const height = Math.min(maxDimension, Math.max(1, Math.round(bitmap.height * scale)))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not create image canvas')
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Image compression failed'))),
      'image/webp',
      quality
    )
  })

  // Browsers without a WebP encoder silently return PNG instead.
  if (blob.type !== 'image/webp') {
    throw new WebpEncodingUnsupportedError()
  }

  return {
    file: new File([blob], name, { type: 'image/webp', lastModified: Date.now() }),
    width,
    height,
  }
}
