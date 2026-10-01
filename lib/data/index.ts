import { phpDataSource } from '@/lib/data/php'
import type { PublicDataSource } from '@/lib/data/types'

/**
 * The active data source for the public pages: the PHP API.
 *
 * The Supabase implementation (lib/data/supabase.ts) satisfies the same
 * contract and could be switched back in here, but it is deliberately not
 * imported, so the public bundle carries no Supabase client.
 * The admin dashboard uses the PHP admin client (lib/adminApi.ts) instead.
 */
const publicData: PublicDataSource = phpDataSource

export const {
  getPhotos,
  getLatestPhotos,
  getCategories,
  getHeroImageUrl,
  getHeroImageSrc,
} = publicData

export type { AdminDataSource, PublicDataSource } from '@/lib/data/types'
