import { supabase } from '@/lib/supabase'
import type { AdminDataSource, PublicDataSource } from '@/lib/data/types'
import type { Category, Photo, StorageUsage } from '@/lib/types'

/**
 * Supabase data source. No longer used by the public pages (see
 * lib/data/php.ts); kept for the admin dashboard until the PHP admin exists,
 * and as a migration reference.
 */

/** A row from the photos table, before the public storage URL is resolved. */
type PhotoRow = Omit<Photo, 'url' | 'thumb_path' | 'thumb_url' | 'width' | 'height' | 'bytes' | 'mime'>

/**
 * Resolves the permanent public URL for a stored photo.
 *
 * These URLs end up in the sitemap and in the page's JSON-LD, so they must stay
 * stable and publicly fetchable. Always use `getPublicUrl` here — a signed URL
 * (`createSignedUrl`) carries an expiry token and would leave Google with dead
 * image links once it expires.
 */
function getPublicPhotoUrl(storagePath: string): string {
  return supabase.storage.from('photos').getPublicUrl(storagePath).data.publicUrl
}

function withPublicUrls(rows: PhotoRow[]): Photo[] {
  return rows.map((row) => ({
    ...row,
    url: getPublicPhotoUrl(row.storage_path),
    // Not stored in Supabase.
    thumb_path: null,
    thumb_url: null,
    width: null,
    height: null,
    bytes: null,
    mime: null,
  }))
}

async function getPhotos(): Promise<Photo[]> {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) { console.error(error); return [] }
  return withPublicUrls(data)
}

async function getLatestPhotos(limit = 8): Promise<Photo[]> {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) { console.error(error); return [] }
  return withPublicUrls(data)
}

async function getHeroImagePath(): Promise<string | null> {
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', 'hero_image_path')
    .maybeSingle()

  if (error) {
    console.error('Failed to fetch hero setting:', error.message)
    return null
  }

  if (!data?.value) {
    console.warn('No hero_image_path exists in site_settings')
    return null
  }

  return data.value
}

async function getHeroImageUrl(): Promise<string | null> {
  const path = await getHeroImagePath()

  if (!path) return null

  const { data } = supabase.storage
    .from('photos')
    .getPublicUrl(path)

  if (!data.publicUrl) {
    console.warn('No public URL could be generated for:', path)
    return null
  }

  // Prevent the browser from showing a cached previous hero.
  return data.publicUrl
}

async function getStorageUsage(): Promise<StorageUsage | null> {
  const { data, error } = await supabase.rpc('get_photos_storage_usage')

  if (error) {
    console.error('Storage usage failed:', error.message)
    return null
  }

  return data?.[0] ?? null
}

async function getCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('label', { ascending: true })

  if (error) {
    console.error(error)
    return []
  }

  return data
}

export const supabaseDataSource: PublicDataSource & AdminDataSource = {
  getPhotos,
  getLatestPhotos,
  getHeroImageUrl,
  getHeroImageSrc: getHeroImageUrl,
  getCategories,
  getStorageUsage,
}
