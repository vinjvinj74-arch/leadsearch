export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'estrutura_inicial',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified_at TIMESTAMPTZ,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));

      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        ip_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

      CREATE TABLE IF NOT EXISTS email_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('verify_email', 'reset_password')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS email_tokens_user_type_idx ON email_tokens (user_id, type);

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
        default_city TEXT,
        default_state TEXT,
        default_country TEXT NOT NULL DEFAULT 'Brasil',
        default_niche TEXT,
        default_limit INTEGER NOT NULL DEFAULT 20 CHECK (default_limit BETWEEN 1 AND 20),
        favorite_niches TEXT[] NOT NULL DEFAULT '{}',
        export_fields TEXT[] NOT NULL DEFAULT ARRAY['name','segment','city','phone','email','website','website_status','score','status'],
        score_weights JSONB,
        allow_enrichment BOOLEAN NOT NULL DEFAULT TRUE,
        retention_days INTEGER NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 3650),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS searches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        niche TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT,
        country TEXT NOT NULL DEFAULT 'Brasil',
        radius_km INTEGER,
        result_limit INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'enriching', 'completed', 'failed')),
        provider TEXT NOT NULL DEFAULT 'google_places',
        provider_request_id TEXT,
        results_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        cost_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS searches_user_created_idx ON searches (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        search_id UUID REFERENCES searches(id) ON DELETE SET NULL,
        place_id TEXT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL DEFAULT '',
        segment TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        address TEXT,
        normalized_address TEXT NOT NULL DEFAULT '',
        phone TEXT,
        normalized_phone TEXT NOT NULL DEFAULT '',
        email TEXT,
        website TEXT,
        normalized_domain TEXT NOT NULL DEFAULT '',
        google_maps_url TEXT,
        rating NUMERIC(2,1),
        reviews_count INTEGER,
        business_status TEXT,
        score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
        score_override INTEGER CHECK (score_override BETWEEN 0 AND 100),
        score_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        website_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (website_status IN ('unknown', 'missing', 'online', 'offline', 'redirect', 'error')),
        website_http_status INTEGER,
        site_has_https BOOLEAN,
        site_response_ms INTEGER,
        redirect_count INTEGER,
        website_last_checked_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'novo'
          CHECK (status IN ('novo','qualificado','contatado','aguardando_resposta','respondeu','reuniao_agendada','proposta_enviada','em_negociacao','vendido','perdido','nao_contatar')),
        do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
        last_contacted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS leads_user_place_uidx ON leads (user_id, place_id) WHERE place_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS leads_user_created_idx ON leads (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS leads_user_status_idx ON leads (user_id, status);
      CREATE INDEX IF NOT EXISTS leads_user_score_idx ON leads (user_id, score DESC);
      CREATE INDEX IF NOT EXISTS leads_user_domain_idx ON leads (user_id, normalized_domain);
      CREATE INDEX IF NOT EXISTS leads_user_phone_idx ON leads (user_id, normalized_phone);
      CREATE INDEX IF NOT EXISTS leads_user_website_status_idx ON leads (user_id, website_status);

      CREATE TABLE IF NOT EXISTS lead_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_url TEXT,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS lead_sources_lead_idx ON lead_sources (lead_id, collected_at DESC);

      CREATE TABLE IF NOT EXISTS lead_contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
        value TEXT NOT NULL,
        source_url TEXT,
        source_type TEXT NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS lead_contacts_lead_idx ON lead_contacts (lead_id, kind);

      CREATE TABLE IF NOT EXISTS lead_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL
          CHECK (type IN ('note','contact','meeting','proposal','result','site_check','enrichment','do_not_contact','status_change')),
        from_status TEXT,
        to_status TEXT,
        note TEXT,
        next_action TEXT,
        next_action_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS lead_activities_lead_idx ON lead_activities (lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS lead_activities_user_idx ON lead_activities (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        ip_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'radar_prospeccao_geografica',
    sql: `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

      CREATE TABLE IF NOT EXISTS radar_searches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        location_query TEXT NOT NULL,
        location_label TEXT NOT NULL,
        location_latitude DOUBLE PRECISION,
        location_longitude DOUBLE PRECISION,
        radius_km INTEGER CHECK (radius_km BETWEEN 1 AND 50),
        country_code TEXT,
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        search_terms TEXT[] NOT NULL DEFAULT '{}',
        result_limit INTEGER NOT NULL CHECK (result_limit BETWEEN 1 AND 20),
        provider TEXT NOT NULL DEFAULT 'apify_google_maps',
        provider_run_id TEXT,
        provider_dataset_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        results_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        cost_note TEXT,
        is_saved BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS radar_searches_user_created_idx ON radar_searches (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS radar_searches_user_saved_idx ON radar_searches (user_id, is_saved, created_at DESC);

      CREATE TABLE IF NOT EXISTS radar_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        search_id UUID NOT NULL REFERENCES radar_searches(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
        fingerprint TEXT NOT NULL,
        place_id TEXT,
        name TEXT NOT NULL,
        category TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        postal_code TEXT,
        phone TEXT,
        email TEXT,
        website TEXT,
        normalized_domain TEXT NOT NULL DEFAULT '',
        google_maps_url TEXT,
        rating NUMERIC(2,1),
        reviews_count INTEGER,
        business_status TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
        score_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        scraped_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (search_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS radar_results_user_search_idx ON radar_results (user_id, search_id, score DESC);
      CREATE INDEX IF NOT EXISTS radar_results_lead_idx ON radar_results (lead_id);
    `,
  },
  {
    version: 3,
    name: 'planos_creditos_admin',
    sql: `
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
    `,
  },
];
