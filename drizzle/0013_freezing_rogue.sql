CREATE TABLE `agent_client` (
	`client_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`host` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_client_secret_hash_unique` ON `agent_client` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `agent_client_org_revoked_idx` ON `agent_client` (`org_id`,`revoked_at`);