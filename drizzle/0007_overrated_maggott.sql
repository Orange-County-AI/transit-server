ALTER TABLE `usage_month` ADD `grace_started_at` integer;--> statement-breakpoint
ALTER TABLE `usage_month` ADD `warning_sent_at` integer;
--> statement-breakpoint
-- The plan set collapsed to free|operator; `fleet` no longer exists. Existing
-- fleet rows must move to operator rather than be left alone: resolvePlan()
-- recognises only active/trialing `operator` and returns `free` for anything
-- else, so an untouched `fleet` row does not error — it silently downgrades a
-- paying organization to the 50k free allowance. Operator has no integration
-- cap under the new model, so accounts carrying more than two integrations
-- stay valid after the move.
UPDATE `subscription` SET `plan` = 'operator' WHERE `plan` = 'fleet';