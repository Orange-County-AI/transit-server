CREATE TABLE `person_address` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`host` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_address_org_host_name_unique` ON `person_address` (`org_id`,`host`,`name`);