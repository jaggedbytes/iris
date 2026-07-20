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
  {
    id: "004_action_outbox_needs_review",
    sql: `
      CREATE TABLE action_dispatch_outbox_next (
        action_request_id TEXT PRIMARY KEY REFERENCES action_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('dispatching', 'dispatched', 'failed', 'retryable', 'needs_review')),
        provider_message_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO action_dispatch_outbox_next SELECT * FROM action_dispatch_outbox;
      DROP TABLE action_dispatch_outbox;
      ALTER TABLE action_dispatch_outbox_next RENAME TO action_dispatch_outbox;
    `,
  },
  {
    id: "005_call_summary_state",
    sql: `
      ALTER TABLE calls ADD COLUMN summary_state TEXT NOT NULL
        DEFAULT 'not_requested'
        CHECK(summary_state IN ('not_requested', 'processing', 'ready', 'unavailable'));
      UPDATE calls
         SET summary_state = 'ready'
       WHERE summary_json IS NOT NULL;
    `,
  },
  {
    id: "006_call_requested_by_contact",
    sql: `
      ALTER TABLE calls ADD COLUMN requested_by_contact_id TEXT
        REFERENCES trusted_contacts(id) ON DELETE SET NULL;
    `,
  },
  {
    id: "007_memory_categories",
    sql: `
      CREATE TABLE memories_next (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        source_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        category TEXT NOT NULL CHECK(category IN ('durable_fact', 'named_person', 'unresolved_topic', 'recall_anchor')),
        payload_json TEXT NOT NULL,
        confidence REAL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      -- Pre-constraint rows could use arbitrary category strings. Only the
      -- allowlisted Bridge categories are copied; unsupported legacy categories
      -- are dropped so the CHECK migration cannot abort mid-upgrade.
      INSERT INTO memories_next (id, person_id, source_call_id, category, payload_json, confidence, expires_at, created_at)
        SELECT id, person_id, source_call_id, category, payload_json, confidence, expires_at, created_at
        FROM memories
        WHERE category IN ('durable_fact', 'named_person', 'unresolved_topic', 'recall_anchor');
      DROP TABLE memories;
      ALTER TABLE memories_next RENAME TO memories;
      CREATE INDEX idx_memories_person_created ON memories(person_id, created_at DESC);
      CREATE INDEX idx_memories_person_category_created ON memories(person_id, category, created_at DESC);
    `,
  },
  {
    id: "008_trusted_contact_sms_opt_in",
    sql: `
      -- action_requests is rebuilt to extend its feature CHECK. Rename the
      -- parent first, then rebuild its dependent child tables so foreign keys
      -- continue to point at the replacement table rather than legacy rows.
      PRAGMA defer_foreign_keys = ON;
      ALTER TABLE action_requests RENAME TO action_requests_legacy;
      CREATE TABLE action_requests (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        feature TEXT NOT NULL CHECK(feature IN ('bridge', 'shield', 'translator', 'enrollment')),
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending_approval', 'approved', 'cancelled', 'dispatched', 'failed')),
        approval_source TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO action_requests
        (id, person_id, feature, action_type, payload_json, status, approval_source, idempotency_key, created_at, updated_at)
        SELECT id, person_id, feature, action_type, payload_json, status, approval_source, idempotency_key, created_at, updated_at
        FROM action_requests_legacy;

      CREATE TABLE messages_next (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        action_request_id TEXT REFERENCES action_requests(id) ON DELETE SET NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        provider_message_id TEXT UNIQUE,
        delivery_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO messages_next
        (id, person_id, action_request_id, direction, provider_message_id, delivery_status, created_at)
        SELECT id, person_id, action_request_id, direction, provider_message_id, delivery_status, created_at
        FROM messages;

      CREATE TABLE action_dispatch_outbox_next (
        action_request_id TEXT PRIMARY KEY REFERENCES action_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('pending', 'dispatching', 'dispatched', 'failed', 'retryable', 'needs_review')),
        provider_message_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO action_dispatch_outbox_next
        (action_request_id, state, provider_message_id, created_at, updated_at)
        SELECT action_request_id, state, provider_message_id, created_at, updated_at
        FROM action_dispatch_outbox;

      DROP TABLE messages;
      DROP TABLE action_dispatch_outbox;
      ALTER TABLE messages_next RENAME TO messages;
      ALTER TABLE action_dispatch_outbox_next RENAME TO action_dispatch_outbox;
      DROP TABLE action_requests_legacy;

      CREATE TABLE trusted_contact_sms_consents (
        id TEXT PRIMARY KEY,
        trusted_contact_id TEXT NOT NULL REFERENCES trusted_contacts(id) ON DELETE CASCADE,
        phone_e164 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('granted', 'revoked')),
        source TEXT NOT NULL CHECK(source IN ('web_form', 'demo_seed', 'inbound_stop')),
        disclosure_version TEXT,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE sms_opt_in_invitations (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        trusted_contact_id TEXT NOT NULL REFERENCES trusted_contacts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_trusted_contact_sms_consents_contact_occurred
        ON trusted_contact_sms_consents(trusted_contact_id, occurred_at DESC);
      CREATE INDEX idx_sms_opt_in_invitations_token ON sms_opt_in_invitations(token_hash);
      CREATE INDEX idx_sms_opt_in_invitations_contact ON sms_opt_in_invitations(trusted_contact_id, created_at DESC);
    `,
  },
  {
    id: "009_trusted_contact_phone_unique",
    sql: `
      CREATE UNIQUE INDEX idx_trusted_contacts_person_phone_unique
        ON trusted_contacts(person_id, phone_e164)
        WHERE phone_e164 IS NOT NULL;
    `,
  },
  {
    id: "010_phone_number_global_uniqueness",
    sql: `
      CREATE TRIGGER prevent_people_phone_from_matching_trusted_contact_on_insert
      BEFORE INSERT ON people
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (SELECT 1 FROM trusted_contacts WHERE phone_e164 = NEW.phone_e164)
      BEGIN
        SELECT RAISE(ABORT, 'phone number is already assigned');
      END;

      CREATE TRIGGER prevent_people_phone_from_matching_trusted_contact_on_update
      BEFORE UPDATE OF phone_e164 ON people
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (SELECT 1 FROM trusted_contacts WHERE phone_e164 = NEW.phone_e164)
      BEGIN
        SELECT RAISE(ABORT, 'phone number is already assigned');
      END;

      CREATE TRIGGER prevent_trusted_contact_phone_from_matching_person_on_insert
      BEFORE INSERT ON trusted_contacts
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (SELECT 1 FROM people WHERE phone_e164 = NEW.phone_e164)
      BEGIN
        SELECT RAISE(ABORT, 'phone number is already assigned');
      END;

      CREATE TRIGGER prevent_trusted_contact_phone_from_matching_person_on_update
      BEFORE UPDATE OF phone_e164 ON trusted_contacts
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (SELECT 1 FROM people WHERE phone_e164 = NEW.phone_e164)
      BEGIN
        SELECT RAISE(ABORT, 'phone number is already assigned');
      END;
    `,
  },
  {
    id: "011_allow_person_trusted_contact_phone_overlap",
    sql: `
      DROP TRIGGER prevent_people_phone_from_matching_trusted_contact_on_insert;
      DROP TRIGGER prevent_people_phone_from_matching_trusted_contact_on_update;
      DROP TRIGGER prevent_trusted_contact_phone_from_matching_person_on_insert;
      DROP TRIGGER prevent_trusted_contact_phone_from_matching_person_on_update;
    `,
  },
  {
    id: "012_person_own_trusted_contact_phone_distinct",
    sql: `
      CREATE TRIGGER prevent_trusted_contact_phone_matching_own_person_on_insert
      BEFORE INSERT ON trusted_contacts
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM people
          WHERE id = NEW.person_id AND phone_e164 = NEW.phone_e164
        )
      BEGIN
        SELECT RAISE(ABORT, 'trusted contact phone matches enrolled person');
      END;

      CREATE TRIGGER prevent_trusted_contact_phone_matching_own_person_on_update
      BEFORE UPDATE OF phone_e164 ON trusted_contacts
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM people
          WHERE id = NEW.person_id AND phone_e164 = NEW.phone_e164
        )
      BEGIN
        SELECT RAISE(ABORT, 'trusted contact phone matches enrolled person');
      END;

      CREATE TRIGGER prevent_person_phone_matching_own_trusted_contact_on_update
      BEFORE UPDATE OF phone_e164 ON people
      WHEN NEW.phone_e164 IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM trusted_contacts
          WHERE person_id = NEW.id AND phone_e164 = NEW.phone_e164
        )
      BEGIN
        SELECT RAISE(ABORT, 'person phone matches trusted contact');
      END;
    `,
  },
  {
    id: "013_access_grants_trusted_contact",
    sql: `
      CREATE INDEX idx_access_grants_trusted_contact
        ON access_grants(trusted_contact_id);
    `,
  },
  {
    id: "014_care_notes",
    sql: `
      CREATE TABLE care_notes (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        author_role TEXT NOT NULL CHECK(author_role IN ('operator', 'trusted_contact')),
        author_trusted_contact_id TEXT REFERENCES trusted_contacts(id) ON DELETE SET NULL,
        author_display_name TEXT NOT NULL,
        author_relationship TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK(
          (author_role = 'operator'
            AND author_trusted_contact_id IS NULL
            AND author_relationship IS NULL)
          OR
          (author_role = 'trusted_contact'
            AND author_relationship IS NOT NULL)
        )
      );

      CREATE INDEX idx_care_notes_person_created
        ON care_notes(person_id, created_at DESC);
    `,
  },
  {
    id: "015_call_thread_links",
    sql: `
      ALTER TABLE care_notes
        ADD COLUMN call_id TEXT REFERENCES calls(id) ON DELETE SET NULL;

      ALTER TABLE action_requests
        ADD COLUMN source_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL;

      CREATE INDEX idx_care_notes_call_created
        ON care_notes(call_id, created_at DESC);

      CREATE INDEX idx_action_requests_source_call
        ON action_requests(source_call_id, created_at DESC);

      CREATE INDEX idx_events_call_occurred
        ON events(call_id, occurred_at DESC);
    `,
  },
  {
    id: "016_care_note_mutability",
    sql: `
      ALTER TABLE care_notes ADD COLUMN updated_at TEXT;
      ALTER TABLE care_notes ADD COLUMN deleted_at TEXT;

      UPDATE care_notes
      SET updated_at = created_at
      WHERE updated_at IS NULL;

      CREATE INDEX idx_care_notes_person_active_created
        ON care_notes(person_id, deleted_at, created_at DESC);

      CREATE INDEX idx_care_notes_call_active_created
        ON care_notes(call_id, deleted_at, created_at ASC);
    `,
  },
] as const;
