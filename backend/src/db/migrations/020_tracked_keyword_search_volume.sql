-- Add Jungle Scout monthly search volume to tracked keywords
ALTER TABLE tracked_keywords ADD COLUMN IF NOT EXISTS search_volume INTEGER;
