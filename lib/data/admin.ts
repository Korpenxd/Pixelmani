import { supabaseDataSource } from '@/lib/data/supabase'
import type { AdminDataSource } from '@/lib/data/types'

/**
 * TEMPORARY: the admin dashboard still reads from Supabase, because its
 * mutations still go through the Next.js /api/admin routes to Supabase.
 * Reads and writes must hit the same store. Replaced when the PHP admin
 * backend exists.
 */
export const adminData: AdminDataSource = supabaseDataSource
