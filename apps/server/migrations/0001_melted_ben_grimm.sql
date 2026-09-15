CREATE TABLE `processed_operations` (
	`list_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`response_json` text NOT NULL,
	`terminal` integer DEFAULT false NOT NULL,
	`processed_at` integer NOT NULL,
	PRIMARY KEY(`list_id`, `operation_id`)
);
--> statement-breakpoint
CREATE INDEX `processed_operations_processed_at_idx` ON `processed_operations` (`processed_at`);--> statement-breakpoint
ALTER TABLE `lists` ADD `revision` integer DEFAULT 0 NOT NULL;