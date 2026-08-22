CREATE TABLE `organization_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`org_a_id` text NOT NULL,
	`org_b_id` text NOT NULL,
	`requested_by_org_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	CONSTRAINT "organization_connection_pair_order_check" CHECK("organization_connection"."org_a_id" < "organization_connection"."org_b_id"),
	CONSTRAINT "organization_connection_requester_check" CHECK("organization_connection"."requested_by_org_id" = "organization_connection"."org_a_id" or "organization_connection"."requested_by_org_id" = "organization_connection"."org_b_id"),
	CONSTRAINT "organization_connection_status_check" CHECK("organization_connection"."status" in ('pending', 'active'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_connection_pair_unique` ON `organization_connection` (`org_a_id`,`org_b_id`);--> statement-breakpoint
CREATE INDEX `organization_connection_org_a_status_idx` ON `organization_connection` (`org_a_id`,`status`);--> statement-breakpoint
CREATE INDEX `organization_connection_org_b_status_idx` ON `organization_connection` (`org_b_id`,`status`);--> statement-breakpoint
ALTER TABLE `message` ADD `recipient_org_id` text;