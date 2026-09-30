-- Required seed data. Idempotent: safe to run any number of times.
--
-- 'okategoriserad' is the fallback category the application relies on: new
-- uploads default to it and deleting a category moves its photos into it.
-- It is a real row so photos.category can keep its foreign key. Public
-- category lists must hide it from the gallery filter buttons; admin and
-- internal code use it normally. The label must stay 'Okategoriserad'.
--
-- Supabase has photos in 'okategoriserad' but no row for it, so this seed
-- must run BEFORE importing the Supabase bundle.
--
-- The fixed id marks this row as a placeholder. When real data is imported
-- from Supabase, the importer replaces the placeholder with the exported
-- 'okategoriserad' row (keeping its original id). If the category already
-- exists, this statement does nothing.

SET NAMES utf8mb4;

INSERT INTO categories (id, `key`, label, created_at)
SELECT '00000000-0000-4000-8000-000000000001', 'okategoriserad', 'Okategoriserad', UTC_TIMESTAMP(6)
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE `key` = 'okategoriserad'
);
