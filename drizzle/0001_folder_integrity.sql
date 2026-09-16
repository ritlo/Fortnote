-- Custom migration (drizzle-kit generate --custom): drizzle-kit cannot express
-- these triggers, so db:generate never recreates this file. Statements are
-- idempotent so databases that already hold these objects migrate cleanly.
CREATE OR REPLACE FUNCTION fortnote_validate_folder_parent_owner()
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
DROP TRIGGER IF EXISTS folders_parent_owner_insert ON folders;
--> statement-breakpoint
CREATE TRIGGER folders_parent_owner_insert
BEFORE INSERT ON folders
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_folder_parent_owner();
--> statement-breakpoint
DROP TRIGGER IF EXISTS folders_parent_owner_update ON folders;
--> statement-breakpoint
CREATE TRIGGER folders_parent_owner_update
BEFORE UPDATE OF parent_folder_id, user_id ON folders
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_folder_parent_owner();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fortnote_validate_note_folder_owner()
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
DROP TRIGGER IF EXISTS notes_folder_owner_insert ON notes;
--> statement-breakpoint
CREATE TRIGGER notes_folder_owner_insert
BEFORE INSERT ON notes
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_note_folder_owner();
--> statement-breakpoint
DROP TRIGGER IF EXISTS notes_folder_owner_update ON notes;
--> statement-breakpoint
CREATE TRIGGER notes_folder_owner_update
BEFORE UPDATE OF folder_id, user_id ON notes
FOR EACH ROW
EXECUTE FUNCTION fortnote_validate_note_folder_owner();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fortnote_reparent_folder_children()
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
DROP TRIGGER IF EXISTS folders_reparent_after_delete ON folders;
--> statement-breakpoint
CREATE TRIGGER folders_reparent_after_delete
BEFORE DELETE ON folders
FOR EACH ROW
EXECUTE FUNCTION fortnote_reparent_folder_children();
