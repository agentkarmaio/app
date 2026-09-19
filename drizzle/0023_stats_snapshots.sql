CREATE TABLE "stats_snapshots" (
	"scope" text NOT NULL,
	"payload" jsonb,
	"as_of" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"generation" integer DEFAULT 0 NOT NULL,
	"owner" uuid,
	"lease_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	CONSTRAINT "stats_snapshots_pkey" PRIMARY KEY("scope"),
	CONSTRAINT "stats_snapshots_scope_check" CHECK ("stats_snapshots"."scope" IN ('core')),
	CONSTRAINT "stats_snapshots_generation_check" CHECK ("stats_snapshots"."generation" >= 0),
	CONSTRAINT "stats_snapshots_failures_check" CHECK ("stats_snapshots"."consecutive_failures" >= 0),
	CONSTRAINT "stats_snapshots_owner_check" CHECK (("stats_snapshots"."owner" IS NULL) = ("stats_snapshots"."lease_until" IS NULL)),
	CONSTRAINT "stats_snapshots_error_check" CHECK ("stats_snapshots"."last_error_code" IS NULL OR "stats_snapshots"."last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "stats_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "stats_snapshots" ("scope") VALUES ('core') ON CONFLICT ("scope") DO NOTHING;
