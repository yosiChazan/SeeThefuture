import { createClient } from '@supabase/supabase-js';

// All application tables live in the `app` schema (CLAUDE.md).
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { db: { schema: 'app' } },
);

// PostgREST errors are plain objects; turn them into real errors for react-query.
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
