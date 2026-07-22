-- Capture-driver hook: screenshots default to the Puppeteer web driver; 'os-agent'
-- is reserved for thick-client-only sites captured via a dedicated view node.
-- capture_settle_ms overrides the post-load render wait (NULL = service default).
ALTER TABLE historian.scada_systems
    ADD COLUMN capture_method TEXT NOT NULL DEFAULT 'web'
        CHECK (capture_method IN ('web', 'os-agent')),
    ADD COLUMN capture_settle_ms INTEGER
        CHECK (capture_settle_ms IS NULL OR capture_settle_ms >= 0);
