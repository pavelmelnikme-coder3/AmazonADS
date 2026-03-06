-- Add region column to amazon_connections
ALTER TABLE amazon_connections 
  ADD COLUMN IF NOT EXISTS region VARCHAR(10) DEFAULT 'EU';

-- Update existing connections based on marketplace
UPDATE amazon_connections SET region = 'EU' WHERE region IS NULL;

-- Add region to amazon_profiles for campaign sync
ALTER TABLE amazon_profiles
  ADD COLUMN IF NOT EXISTS region VARCHAR(10) DEFAULT 'EU';
