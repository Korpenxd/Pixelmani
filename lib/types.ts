/**
 * Application domain types. Independent of where the data is stored, so UI
 * code never has to import from a specific backend implementation.
 */

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
  /** Migration fields. Null until thumbnails/metadata exist (and always from Supabase). */
  thumb_path: string | null
  /** Smaller variant for grids and cards; fall back to `url` when null. */
  thumb_url: string | null
  width: number | null
  height: number | null
  bytes: number | null
  mime: string | null
}

export type Category = {
  id: string
  key: string
  label: string
  created_at: string
}

/** Storage used by uploaded photos, as shown in the admin dashboard. */
export type StorageUsage = {
  total_bytes: number
  total_mb: number
  file_count: number
}
