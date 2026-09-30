import { supabaseDataSource } from '@/lib/data/supabase'
import type { DataSource } from '@/lib/data/types'

/**
 * The active data source. Supabase is the only implementation for now; a
 * PHP/MySQL implementation will be selectable here later without the rest of
 * the app changing.
 */
const dataSource: DataSource = supabaseDataSource

export const {
  getPhotos,
  getLatestPhotos,
  getHeroImagePath,
  getHeroImageUrl,
  getCategories,
  getStorageUsage,
  getPublicPhotoUrl,
  subscribeToPhotoChanges,
} = dataSource

export type { DataSource } from '@/lib/data/types'
