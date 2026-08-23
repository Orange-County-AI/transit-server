-- DEFAULT '' exists only because SQLite ADD COLUMN NOT NULL demands a default; the next statement backfills existing rows.
ALTER TABLE `room_member` ADD `member_org_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `room_member` SET `member_org_id` = `org_id` WHERE `member_org_id` = '';