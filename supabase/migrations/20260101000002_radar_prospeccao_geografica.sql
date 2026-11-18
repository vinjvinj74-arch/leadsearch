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
