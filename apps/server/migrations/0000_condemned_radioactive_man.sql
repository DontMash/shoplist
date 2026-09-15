CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`amount` text DEFAULT '' NOT NULL,
	`collected` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`by` text,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_list_id_idx` ON `items` (`list_id`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`cleared_at` integer
);
--> statement-breakpoint
CREATE TABLE `members` (
	`list_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`list_id`, `client_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
