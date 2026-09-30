import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

/**
 * Public (anon) Supabase client. Only the Supabase data source in
 * lib/data/supabase.ts should use it — app code reads through `@/lib/data`.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
