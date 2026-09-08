import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/** A row from the photos table, before the public storage URL is resolved. */
type PhotoRow = Omit<Photo, 'url'>

/**
 * Resolves the permanent public URL for each photo.
 *
 * These URLs end up in the sitemap and in the page's JSON-LD, so they must stay
 * stable and publicly fetchable. Always use `getPublicUrl` here — a signed URL
 * (`createSignedUrl`) carries an expiry token and would leave Google with dead
 * image links once it expires.
 */
function withPublicUrls(rows: PhotoRow[]): Photo[] {
  return rows.map((row) => ({
    ...row,
    url: supabase.storage.from('photos').getPublicUrl(row.storage_path).data.publicUrl,
  }))
}

export type Photo = {
  id: string
  name: string
  storage_path: string
  url: string
  category: string
  title: string | null
  location: string | null
  date: string | null
  created_at: string
  is_hero: boolean
}

export async function getPhotos(): Promise<Photo[]> {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) { console.error(error); return [] }
  return withPublicUrls(data)
}

export async function getLatestPhotos(limit = 8): Promise<Photo[]> {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) { console.error(error); return [] }
  return withPublicUrls(data)
}

export async function getPhotosByCategory(category: string): Promise<Photo[]> {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .eq('category', category)
    .order('created_at', { ascending: false })
  if (error) { console.error(error); return [] }
  return withPublicUrls(data)
}

export async function getHeroImagePath(): Promise<string | null> {
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

export async function getHeroImageUrl(): Promise<string | null> {
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



export async function getStorageUsage() {
  const { data, error } = await supabase.rpc('get_photos_storage_usage')

  if (error) {
    console.error('Storage usage failed:', error.message)
    return null
  }

  return data?.[0] ?? null
}

export type Category = {
  id: string
  key: string
  label: string
  created_at: string
}

export async function getCategories(): Promise<Category[]> {
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
