-- When a refresh token was last rotated. A rotated token presented again within a few seconds is two tabs racing, not theft.
ALTER TABLE sessions ADD COLUMN rotated_at TIMESTAMPTZ;
