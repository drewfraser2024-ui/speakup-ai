-- Run this in your Supabase SQL editor to create the sessions table
-- Go to: https://supabase.com/dashboard → Your Project → SQL Editor

CREATE TABLE sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  difficulty TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  scores JSONB DEFAULT '{}'::jsonb,
  duration_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security (open access for now - add auth later)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access" ON sessions
  FOR ALL USING (true) WITH CHECK (true);

-- Index for fast recent-sessions queries
CREATE INDEX idx_sessions_created_at ON sessions (created_at DESC);
