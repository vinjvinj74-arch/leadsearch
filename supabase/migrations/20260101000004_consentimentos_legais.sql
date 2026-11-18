UPDATE plans SET name = 'Básico' WHERE id = 'basico';

      CREATE TABLE IF NOT EXISTS user_consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        document TEXT NOT NULL,
        version TEXT NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip_hash TEXT,
        user_agent TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (user_id, document, version)
      );

      CREATE INDEX IF NOT EXISTS user_consents_user_idx ON user_consents (user_id, accepted_at DESC);
