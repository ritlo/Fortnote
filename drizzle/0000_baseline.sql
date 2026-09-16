CREATE TABLE "attachment_object_chunks" (
	"storage_key" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	CONSTRAINT "attachment_object_chunks_storage_key_chunk_index_pk" PRIMARY KEY("storage_key","chunk_index"),
	CONSTRAINT "attachment_object_chunks_nonnegative_index" CHECK ("attachment_object_chunks"."chunk_index" >= 0),
	CONSTRAINT "attachment_object_chunks_nonempty_ciphertext" CHECK (octet_length("attachment_object_chunks"."ciphertext") > 0)
);
--> statement-breakpoint
CREATE TABLE "attachment_objects" (
	"storage_key" uuid PRIMARY KEY NOT NULL,
	"byte_length" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_objects_nonnegative_length" CHECK ("attachment_objects"."byte_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"user_id" text NOT NULL,
	"metadata_cipher" text NOT NULL,
	"metadata_nonce" text NOT NULL,
	"metadata_format_version" integer DEFAULT 2 NOT NULL,
	"key_epoch" integer DEFAULT 1 NOT NULL,
	"size" bigint NOT NULL,
	"encrypted_attachment_key" text NOT NULL,
	"attachment_key_nonce" text NOT NULL,
	"storage_key" uuid NOT NULL,
	"file_nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_chunks" (
	"upload_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"cipher_length" integer NOT NULL,
	"cipher_hash" text NOT NULL,
	"file_cipher_path" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_chunks_upload_id_chunk_index_pk" PRIMARY KEY("upload_id","chunk_index"),
	CONSTRAINT "content_chunks_nonnegative_index" CHECK ("content_chunks"."chunk_index" >= 0),
	CONSTRAINT "content_chunks_positive_length" CHECK ("content_chunks"."cipher_length" > 0)
);
--> statement-breakpoint
CREATE TABLE "content_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"upload_id" text NOT NULL,
	"update_id" text NOT NULL,
	"note_id" text NOT NULL,
	"section_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"format_version" integer NOT NULL,
	"first_sequence" integer NOT NULL,
	"last_sequence" integer NOT NULL,
	"total_cipher_bytes" bigint NOT NULL,
	"chunk_count" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"checkpoint_sequence_cutoff" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_manifests_kind" CHECK ("content_manifests"."kind" IN ('update', 'checkpoint', 'root-update')),
	CONSTRAINT "content_manifests_positive_bytes" CHECK ("content_manifests"."total_cipher_bytes" > 0),
	CONSTRAINT "content_manifests_positive_chunks" CHECK ("content_manifests"."chunk_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "content_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"update_id" text NOT NULL,
	"note_id" text NOT NULL,
	"section_id" text NOT NULL,
	"crypto_owner_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"format_version" integer NOT NULL,
	"total_cipher_bytes" bigint NOT NULL,
	"chunk_count" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"checkpoint_sequence_cutoff" integer,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_uploads_positive_bytes" CHECK ("content_uploads"."total_cipher_bytes" > 0),
	CONSTRAINT "content_uploads_positive_chunks" CHECK ("content_uploads"."chunk_count" > 0),
	CONSTRAINT "content_uploads_kind" CHECK ("content_uploads"."kind" IN ('update', 'checkpoint', 'root-update')),
	CONSTRAINT "content_uploads_status" CHECK ("content_uploads"."status" IN ('receiving', 'complete', 'committed', 'aborted', 'expired', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "crdt_initializations" (
	"note_id" text NOT NULL,
	"section_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"manifest_id" text NOT NULL,
	"root_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crdt_initializations_note_id_section_id_key_epoch_pk" PRIMARY KEY("note_id","section_id","key_epoch")
);
--> statement-breakpoint
CREATE TABLE "event_acknowledgements" (
	"user_id" text NOT NULL,
	"note_id" text NOT NULL,
	"cursor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_acknowledgements_user_id_note_id_pk" PRIMARY KEY("user_id","note_id")
);
--> statement-breakpoint
CREATE TABLE "event_cursors" (
	"user_id" text PRIMARY KEY NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name_cipher" text NOT NULL,
	"name_nonce" text NOT NULL,
	"name_format_version" integer DEFAULT 2 NOT NULL,
	"parent_folder_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_epoch_links" (
	"note_id" text NOT NULL,
	"target_epoch" integer NOT NULL,
	"source_epoch" integer NOT NULL,
	"previous_key_cipher" text NOT NULL,
	"nonce" text NOT NULL,
	"format_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_epoch_links_note_id_target_epoch_pk" PRIMARY KEY("note_id","target_epoch"),
	CONSTRAINT "note_epoch_links_adjacent" CHECK ("note_epoch_links"."target_epoch" = "note_epoch_links"."source_epoch" + 1)
);
--> statement-breakpoint
CREATE TABLE "note_events" (
	"cursor" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"note_id" text,
	"actor_user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"note_version" integer,
	"payload_metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "note_key_shares" (
	"note_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"sender_user_id" text NOT NULL,
	"sharing_key_version" integer NOT NULL,
	"encrypted_note_key" text NOT NULL,
	"format_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_key_shares_note_id_recipient_user_id_pk" PRIMARY KEY("note_id","recipient_user_id")
);
--> statement-breakpoint
CREATE TABLE "note_memberships" (
	"note_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_memberships_note_id_user_id_pk" PRIMARY KEY("note_id","user_id"),
	CONSTRAINT "note_memberships_role" CHECK ("note_memberships"."role" IN ('owner', 'editor', 'viewer')),
	CONSTRAINT "note_memberships_status" CHECK ("note_memberships"."status" IN ('active', 'invited', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "note_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"created_epoch" integer NOT NULL,
	"current_sequence" integer DEFAULT 0 NOT NULL,
	"initialization_manifest_id" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"crypto_owner_id" text NOT NULL,
	"folder_id" text,
	"title_cipher" text NOT NULL,
	"title_nonce" text NOT NULL,
	"title_format_version" integer DEFAULT 2 NOT NULL,
	"encrypted_note_key" text NOT NULL,
	"note_key_nonce" text NOT NULL,
	"note_key_format_version" integer DEFAULT 2 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"root_version" integer DEFAULT 1 NOT NULL,
	"root_section_id" text NOT NULL,
	"key_epoch" integer DEFAULT 1 NOT NULL,
	"rotation_fenced" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "section_updates" (
	"update_id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"section_id" text NOT NULL,
	"server_sequence" integer NOT NULL,
	"crypto_owner_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"format_version" integer NOT NULL,
	"kind" text NOT NULL,
	"inline_cipher" "bytea",
	"nonce" "bytea",
	"checkpoint_sequence_cutoff" integer,
	"manifest_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "section_updates_kind" CHECK ("section_updates"."kind" IN ('update', 'checkpoint', 'root-update'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
CREATE TABLE "storage_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_accounts_used_nonnegative" CHECK ("storage_accounts"."used_bytes" >= 0),
	CONSTRAINT "storage_accounts_reserved_nonnegative" CHECK ("storage_accounts"."reserved_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_key_material" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encrypted_root_key" text NOT NULL,
	"root_key_nonce" text NOT NULL,
	"root_key_format_version" integer DEFAULT 1 NOT NULL,
	"root_key_context_version" integer DEFAULT 1 NOT NULL,
	"kdf_salt" text NOT NULL,
	"kdf_ops_limit" integer NOT NULL,
	"kdf_mem_limit" integer NOT NULL,
	"kdf_version" integer NOT NULL,
	"recovery_encrypted_root_key" text NOT NULL,
	"recovery_root_key_nonce" text NOT NULL,
	"recovery_root_key_format_version" integer DEFAULT 1 NOT NULL,
	"recovery_root_key_context_version" integer DEFAULT 1 NOT NULL,
	"recovery_auth_verifier_hash" text NOT NULL,
	"recovery_kdf_salt" text NOT NULL,
	"recovery_kdf_ops_limit" integer NOT NULL,
	"recovery_kdf_mem_limit" integer NOT NULL,
	"recovery_kdf_version" integer NOT NULL,
	"key_material_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sharing_keys" (
	"user_id" text NOT NULL,
	"sharing_key_version" integer NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"private_key_nonce" text NOT NULL,
	"format_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sharing_keys_user_id_sharing_key_version_pk" PRIMARY KEY("user_id","sharing_key_version")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"canonical_handle" text,
	"auth_verifier_hash" text NOT NULL,
	"auth_kdf_salt" text NOT NULL,
	"auth_kdf_ops_limit" integer NOT NULL,
	"auth_kdf_mem_limit" integer NOT NULL,
	"auth_kdf_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "attachment_object_chunks" ADD CONSTRAINT "attachment_object_chunks_storage_key_attachment_objects_storage_key_fk" FOREIGN KEY ("storage_key") REFERENCES "public"."attachment_objects"("storage_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_storage_key_attachment_objects_storage_key_fk" FOREIGN KEY ("storage_key") REFERENCES "public"."attachment_objects"("storage_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_upload_id_content_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."content_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_manifests" ADD CONSTRAINT "content_manifests_upload_id_content_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."content_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_manifests" ADD CONSTRAINT "content_manifests_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_manifests" ADD CONSTRAINT "content_manifests_section_id_note_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."note_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_uploads" ADD CONSTRAINT "content_uploads_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_uploads" ADD CONSTRAINT "content_uploads_section_id_note_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."note_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crdt_initializations" ADD CONSTRAINT "crdt_initializations_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crdt_initializations" ADD CONSTRAINT "crdt_initializations_section_id_note_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."note_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crdt_initializations" ADD CONSTRAINT "crdt_initializations_manifest_id_content_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."content_manifests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_acknowledgements" ADD CONSTRAINT "event_acknowledgements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_cursors" ADD CONSTRAINT "event_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_epoch_links" ADD CONSTRAINT "note_epoch_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_events" ADD CONSTRAINT "note_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_key_shares" ADD CONSTRAINT "note_key_shares_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_key_shares" ADD CONSTRAINT "note_key_shares_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_key_shares" ADD CONSTRAINT "note_key_shares_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_memberships" ADD CONSTRAINT "note_memberships_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_memberships" ADD CONSTRAINT "note_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_sections" ADD CONSTRAINT "note_sections_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_crypto_owner_id_users_id_fk" FOREIGN KEY ("crypto_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_updates" ADD CONSTRAINT "section_updates_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_updates" ADD CONSTRAINT "section_updates_section_id_note_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."note_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_accounts" ADD CONSTRAINT "storage_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_key_material" ADD CONSTRAINT "user_key_material_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sharing_keys" ADD CONSTRAINT "user_sharing_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_content_manifests_upload" ON "content_manifests" USING btree ("upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_content_manifests_update" ON "content_manifests" USING btree ("update_id");--> statement-breakpoint
CREATE INDEX "idx_content_manifests_page" ON "content_manifests" USING btree ("note_id","section_id","key_epoch","last_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_content_uploads_update" ON "content_uploads" USING btree ("update_id");--> statement-breakpoint
CREATE INDEX "idx_content_uploads_note_status" ON "content_uploads" USING btree ("note_id","status");--> statement-breakpoint
CREATE INDEX "idx_content_uploads_expiry" ON "content_uploads" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_event_acknowledgements_user_cursor" ON "event_acknowledgements" USING btree ("user_id","cursor");--> statement-breakpoint
CREATE INDEX "idx_event_cursors_cursor" ON "event_cursors" USING btree ("cursor");--> statement-breakpoint
CREATE INDEX "idx_note_events_note_cursor" ON "note_events" USING btree ("note_id","cursor");--> statement-breakpoint
CREATE INDEX "idx_note_events_resource_cursor" ON "note_events" USING btree ("resource_type","resource_id","cursor");--> statement-breakpoint
CREATE INDEX "idx_note_key_shares_recipient" ON "note_key_shares" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "idx_note_memberships_user_status" ON "note_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_note_memberships_note" ON "note_memberships" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "idx_note_sections_note_deleted" ON "note_sections" USING btree ("note_id","is_deleted");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_section_updates_sequence" ON "section_updates" USING btree ("note_id","section_id","key_epoch","server_sequence");--> statement-breakpoint
CREATE INDEX "idx_section_updates_page" ON "section_updates" USING btree ("note_id","section_id","key_epoch","server_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_canonical_handle" ON "users" USING btree ("canonical_handle") WHERE "users"."canonical_handle" IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION fortnote_validate_folder_parent_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM folders AS parent
    WHERE parent.id = NEW.parent_folder_id
      AND parent.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'invalid folder parent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER folders_parent_owner_insert
BEFORE INSERT ON folders
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_folder_parent_owner();
--> statement-breakpoint
CREATE TRIGGER folders_parent_owner_update
BEFORE UPDATE OF parent_folder_id, user_id ON folders
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_folder_parent_owner();
--> statement-breakpoint
CREATE FUNCTION fortnote_validate_note_folder_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM folders
    WHERE folders.id = NEW.folder_id
      AND folders.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'invalid note folder' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER notes_folder_owner_insert
BEFORE INSERT ON notes
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_note_folder_owner();
--> statement-breakpoint
CREATE TRIGGER notes_folder_owner_update
BEFORE UPDATE OF folder_id, user_id ON notes
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_note_folder_owner();
--> statement-breakpoint
CREATE FUNCTION fortnote_reparent_folder_children()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE notes
  SET folder_id = OLD.parent_folder_id,
      updated_at = CURRENT_TIMESTAMP
  WHERE folder_id = OLD.id
    AND user_id = OLD.user_id;

  UPDATE folders
  SET parent_folder_id = OLD.parent_folder_id,
      updated_at = CURRENT_TIMESTAMP
  WHERE parent_folder_id = OLD.id
    AND user_id = OLD.user_id;

  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER folders_reparent_after_delete
BEFORE DELETE ON folders
FOR EACH ROW
EXECUTE FUNCTION fortnote_reparent_folder_children();
