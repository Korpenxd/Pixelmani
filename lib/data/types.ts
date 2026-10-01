import type { Category, Photo } from '@/lib/types'

/**
 * Read operations behind the public pages. The active implementation is
 * chosen in lib/data/index.ts; components only talk to this contract.
 */
export type PublicDataSource = {
  /** All photos, newest first. */
  getPhotos(): Promise<Photo[]>

  /** The newest photos, newest first. */
  getLatestPhotos(limit?: number): Promise<Photo[]>

  /** Gallery filter categories sorted by label (internal fallback excluded). */
  getCategories(): Promise<Category[]>

  /** URL of the current hero image file, if one is set (sitemap, SEO). */
  getHeroImageUrl(): Promise<string | null>

  /**
   * What the start page uses as the hero `<img src>`, if a hero is set. May
   * be a stable endpoint rather than the file itself, so the static HTML can
   * reference (and preload) it without knowing which file is current.
   */
  getHeroImageSrc(): Promise<string | null>
}
