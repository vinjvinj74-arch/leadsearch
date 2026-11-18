-- ---------------------------------------------------------------------
      -- Papeis: somente o e-mail autorizado pode ser super_admin.
      -- ---------------------------------------------------------------------
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      UPDATE users SET role = 'user' WHERE role NOT IN ('user', 'admin', 'super_admin');
      UPDATE users SET role = 'super_admin' WHERE lower(email) = lower('vinjvinj74@gmail.com');
      UPDATE users SET role = 'user' WHERE role = 'admin';
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'super_admin'));
      ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

      -- ---------------------------------------------------------------------
      -- Planos comerciais: fonte de verdade persistida (a aplicacao tambem
      -- valida os mesmos valores em src/plans.ts).
      -- ---------------------------------------------------------------------
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

      INSERT INTO plans (id, name, monthly_price_cents, monthly_credits, description, features, sort_order, is_active)
      VALUES
        (
          'starter', 'Starter', 3990, 300,
          'Para quem está começando a prospectar com constância.',
          '["Pesquisa de empresas por nicho e localização","Até 5 empresas por pesquisa","Mapa, filtros geográficos e pontuação explicável","CRM com histórico de atividades","Enriquecimento de contatos públicos","Exportação CSV"]'::jsonb,
          1, TRUE
        ),
        (
          'pro', 'Pro', 6700, 1000,
          'Para rotinas comerciais com volume maior de prospecção.',
          '["Tudo do Starter","1.000 créditos por mês","Histórico completo de pesquisas","Filtros avançados no Radar","Exportação CSV com campos personalizados","Enriquecimento de contatos públicos"]'::jsonb,
          2, TRUE
        ),
        (
          'business', 'Business', 19700, 5000,
          'Para operações que precisam de alto volume de pesquisas.',
          '["Tudo do Pro","5.000 créditos por mês","Volume ampliado de prospecção","Histórico completo de pesquisas","Exportação CSV com campos personalizados","Suporte por e-mail"]'::jsonb,
          3, TRUE
        )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        monthly_price_cents = EXCLUDED.monthly_price_cents,
        monthly_credits = EXCLUDED.monthly_credits,
        description = EXCLUDED.description,
        features = EXCLUDED.features,
        sort_order = EXCLUDED.sort_order,
        is_active = EXCLUDED.is_active,
        updated_at = now();

      -- Planos legados permanecem para historico, mas nao concedem acesso.
      UPDATE plans SET is_active = FALSE, updated_at = now()
      WHERE id NOT IN ('starter', 'pro', 'business');

      -- ---------------------------------------------------------------------
      -- Assinaturas: periodo, provedor e status completos.
      -- ---------------------------------------------------------------------
      ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
      ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_status_check
        CHECK (status IN ('active', 'past_due', 'canceled', 'pending', 'expired', 'refunded', 'incomplete'));

      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT;
      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id TEXT;
      ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ;
      ALTER TABLE user_subscriptions ALTER COLUMN plan_id DROP NOT NULL;

      UPDATE user_subscriptions
      SET
        current_period_start = COALESCE(current_period_start, started_at, created_at),
        current_period_end = COALESCE(current_period_end, ends_at, credits_reset_at),
        credits_used = GREATEST(credits_used, 0),
        credits_limit = GREATEST(credits_limit, 0),
        updated_at = now();

      -- Assinaturas de planos descontinuados deixam de conceder acesso,
      -- mas permanecem registradas para rastreabilidade.
      UPDATE user_subscriptions s
      SET
        status = 'canceled',
        current_period_end = COALESCE(s.current_period_end, s.ends_at, now()),
        updated_at = now()
      WHERE s.plan_id IS NOT NULL
        AND s.plan_id NOT IN ('starter', 'pro', 'business');

      CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_provider_sub_uidx
        ON user_subscriptions (provider, provider_subscription_id)
        WHERE provider_subscription_id IS NOT NULL;

      -- ---------------------------------------------------------------------
      -- Historico de creditos e eventos de cobranca.
      -- ---------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('grant', 'consume', 'refund', 'adjustment', 'reset', 'expire')),
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
        plan_id TEXT,
        search_id UUID,
        reference TEXT,
        description TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_user_reference_uidx
        ON credit_transactions (user_id, reference)
        WHERE reference IS NOT NULL;
      CREATE INDEX IF NOT EXISTS credit_transactions_user_created_idx
        ON credit_transactions (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS credit_transactions_search_idx
        ON credit_transactions (search_id)
        WHERE search_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS subscription_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        provider TEXT,
        reference TEXT,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_provider_reference_uidx
        ON subscription_events (provider, reference)
        WHERE reference IS NOT NULL;
      CREATE INDEX IF NOT EXISTS subscription_events_user_created_idx
        ON subscription_events (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS payment_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT,
        status TEXT NOT NULL DEFAULT 'processing'
          CHECK (status IN ('processing', 'processed', 'failed', 'ignored')),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        UNIQUE (provider, event_id)
      );
      CREATE INDEX IF NOT EXISTS payment_events_created_idx ON payment_events (created_at DESC);

      CREATE TABLE IF NOT EXISTS checkout_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT UNIQUE,
        provider_session_url TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'completed', 'expired', 'canceled', 'failed')),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS checkout_sessions_user_created_idx
        ON checkout_sessions (user_id, created_at DESC);

      -- ---------------------------------------------------------------------
      -- Solicitacoes de contato, privacidade e exclusao de dados.
      -- ---------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS contact_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('support', 'privacy', 'data_deletion', 'commercial', 'security')),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        ip_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        handled_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS contact_requests_created_idx ON contact_requests (created_at DESC);
      CREATE INDEX IF NOT EXISTS contact_requests_kind_status_idx ON contact_requests (kind, status);
