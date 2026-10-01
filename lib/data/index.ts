import { phpDataSource } from '@/lib/data/php'
import type { PublicDataSource } from '@/lib/data/types'

/**
 * The data source for the public pages: the PHP API. Used at build time (the
 * static export's snapshot) and in the browser (the runtime refresh).
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

export type { PublicDataSource } from '@/lib/data/types'
