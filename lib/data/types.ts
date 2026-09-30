import type { Category, Photo, StorageUsage } from '@/lib/types'

/**
 * Read operations the public site and the admin dashboard need. Each backend
 * (Supabase today) provides one implementation; the rest of the app only
 * talks to this contract through `@/lib/data`.
 */
export type DataSource = {
  /** All photos, newest first. */
  getPhotos(): Promise<Photo[]>

  /** The newest photos, newest first. */
  getLatestPhotos(limit?: number): Promise<Photo[]>

  /** Stored path of the current landing (hero) image, if one is set. */
  getHeroImagePath(): Promise<string | null>

  /** Public URL of the current landing (hero) image, if one is set. */
  getHeroImageUrl(): Promise<string | null>

  /** All categories, sorted by label. */
  getCategories(): Promise<Category[]>

  getStorageUsage(): Promise<StorageUsage | null>

  /** Permanent, publicly fetchable URL for a stored photo path. */
  getPublicPhotoUrl(storagePath: string): string

  /**
   * Calls `onChange` whenever the photo collection changes. Returns a
   * function that stops listening.
   */
  subscribeToPhotoChanges(channelName: string, onChange: () => void): () => void
}
