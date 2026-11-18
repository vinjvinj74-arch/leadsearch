ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'));
      UPDATE users SET role = 'admin' WHERE lower(email) = 'vinjvinj74@gmail.com';

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        monthly_price_cents INTEGER NOT NULL,
        monthly_credits INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO plans (id, name, monthly_price_cents, monthly_credits)
      VALUES
        ('basico', 'Básico', 3990, 25),
        ('ilimitado', 'Ilimitado', 9790, 150)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        monthly_price_cents = EXCLUDED.monthly_price_cents,
        monthly_credits = EXCLUDED.monthly_credits;

      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','canceled')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ends_at TIMESTAMPTZ,
        credits_used INTEGER NOT NULL DEFAULT 0,
        credits_limit INTEGER NOT NULL DEFAULT 0,
        credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id)
      );

      CREATE INDEX IF NOT EXISTS user_subscriptions_user_idx ON user_subscriptions (user_id);
