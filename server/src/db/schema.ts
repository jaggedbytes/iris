export const migrations = [
  {
    id: "001_foundation",
    sql: `
      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        phone_e164 TEXT UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE trusted_contacts (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        phone_e164 TEXT,
        relationship TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE access_grants (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        trusted_contact_id TEXT NOT NULL REFERENCES trusted_contacts(id) ON DELETE CASCADE,
        scopes_json TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE consents (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('granted', 'revoked')),
        source TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE calls (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        provider_call_id TEXT UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('attempted', 'answered', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary_json TEXT
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        source_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        confidence REAL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE action_requests (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        feature TEXT NOT NULL CHECK(feature IN ('bridge', 'shield', 'translator')),
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending_approval', 'approved', 'cancelled', 'dispatched', 'failed')),
        approval_source TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        action_request_id TEXT REFERENCES action_requests(id) ON DELETE SET NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        provider_message_id TEXT UNIQUE,
        delivery_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        source_text TEXT NOT NULL,
        explanation_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX idx_calls_person_started ON calls(person_id, started_at DESC);
      CREATE INDEX idx_consents_person_kind ON consents(person_id, kind, granted_at DESC);
      CREATE INDEX idx_events_person_occurred ON events(person_id, occurred_at DESC);
      CREATE INDEX idx_memories_person_created ON memories(person_id, created_at DESC);
    `,
  },
  {
    id: "002_action_outbox",
    sql: `
      CREATE TABLE action_dispatch_outbox (
        action_request_id TEXT PRIMARY KEY REFERENCES action_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('dispatching', 'dispatched')),
        provider_message_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: "003_action_outbox_failed",
    sql: `
      CREATE TABLE action_dispatch_outbox_next (
        action_request_id TEXT PRIMARY KEY REFERENCES action_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('dispatching', 'dispatched', 'failed', 'retryable')),
        provider_message_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO action_dispatch_outbox_next SELECT * FROM action_dispatch_outbox;
      DROP TABLE action_dispatch_outbox;
      ALTER TABLE action_dispatch_outbox_next RENAME TO action_dispatch_outbox;
    `,
  },
] as const;
