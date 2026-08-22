CREATE TABLE `agent_snapshot` (
	`host_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`pane_id` text NOT NULL,
	`status` text NOT NULL,
	`named_by` text NOT NULL,
	`title` text NOT NULL,
	`cwd` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`host_id`, `name`),
	CONSTRAINT "agent_snapshot_named_by_check" CHECK("agent_snapshot"."named_by" in ('user', 'auto'))
);
--> statement-breakpoint
CREATE INDEX `agent_snapshot_host_status_idx` ON `agent_snapshot` (`host_id`,`status`);--> statement-breakpoint
CREATE TABLE `enroll_code` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `enroll_code_org_slug_idx` ON `enroll_code` (`org_id`,`slug`);--> statement-breakpoint
CREATE TABLE `host` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_issued_at` integer NOT NULL,
	`daemon_ver` text NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_org_slug_unique` ON `host` (`org_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_token_hash_unique` ON `host` (`token_hash`);--> statement-breakpoint
CREATE INDEX `host_org_revoked_idx` ON `host` (`org_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `ingest_source` (
	`org_id` text NOT NULL,
	`source` text NOT NULL,
	`secret_enc` text NOT NULL,
	`reply_url` text,
	`reply_url_prefixes` text DEFAULT '[]' NOT NULL,
	`instructions` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `source`)
);
--> statement-breakpoint
CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`connector` text NOT NULL,
	`name` text NOT NULL,
	`config_enc` text NOT NULL,
	`target_addr` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "integration_status_check" CHECK("integration"."status" in ('active', 'paused'))
);
--> statement-breakpoint
CREATE INDEX `integration_org_status_idx` ON `integration` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `integration_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`target_addr` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`read_at` integer,
	`settled_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "integration_delivery_status_check" CHECK("integration_delivery"."status" in ('pending', 'dispatched', 'read', 'replied', 'handled', 'dead'))
);
--> statement-breakpoint
CREATE INDEX `integration_delivery_event_idx` ON `integration_delivery` (`event_id`);--> statement-breakpoint
CREATE INDEX `integration_delivery_target_status_idx` ON `integration_delivery` (`target_addr`,`status`);--> statement-breakpoint
CREATE INDEX `integration_delivery_status_created_idx` ON `integration_delivery` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `integration_event` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`event_key` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user` text,
	`trigger` text,
	`content` text NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_event_key_unique` ON `integration_event` (`integration_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `integration_event_received_idx` ON `integration_event` (`integration_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `integration_reply` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`message` text NOT NULL,
	`reply_mode` text,
	`posted_at` integer,
	`post_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "integration_reply_mode_check" CHECK("integration_reply"."reply_mode" is null or "integration_reply"."reply_mode" in ('root', 'thread'))
);
--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_addr` text NOT NULL,
	`to_addr` text NOT NULL,
	`room_seq` integer,
	`body` text NOT NULL,
	`reply_to` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "message_kind_check" CHECK("message"."kind" in ('dm', 'room')),
	CONSTRAINT "message_room_seq_check" CHECK(("message"."kind" = 'dm' and "message"."room_seq" is null) or ("message"."kind" = 'room' and "message"."room_seq" is not null))
);
--> statement-breakpoint
CREATE INDEX `message_org_created_idx` ON `message` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_org_to_created_idx` ON `message` (`org_id`,`to_addr`,`created_at`);--> statement-breakpoint
CREATE TABLE `message_delivery` (
	`message_id` text NOT NULL,
	`target_addr` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `target_addr`),
	CONSTRAINT "message_delivery_status_check" CHECK("message_delivery"."status" in ('queued', 'injected', 'dead'))
);
--> statement-breakpoint
CREATE INDEX `message_delivery_target_status_idx` ON `message_delivery` (`target_addr`,`status`);--> statement-breakpoint
CREATE TABLE `room` (
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `name`),
	CONSTRAINT "room_policy_check" CHECK("room"."policy" in ('open', 'invite'))
);
--> statement-breakpoint
CREATE TABLE `room_member` (
	`org_id` text NOT NULL,
	`room` text NOT NULL,
	`address` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `room`, `address`)
);
--> statement-breakpoint
CREATE INDEX `room_member_address_idx` ON `room_member` (`org_id`,`address`);