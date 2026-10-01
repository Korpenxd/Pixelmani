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
  /** Null for photos migrated without thumbnails/metadata; set for every new upload. */
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
