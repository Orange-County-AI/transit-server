CREATE TABLE `device_authorization` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`org_id` text,
	`slug` text,
	`hostname` text NOT NULL,
	`daemon_ver` text NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`claimed_at` integer,
	`polled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorization_user_code_unique` ON `device_authorization` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_authorization_expires_idx` ON `device_authorization` (`expires_at`);