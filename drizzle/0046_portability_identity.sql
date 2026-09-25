CREATE TABLE "portability_identity" (
	"id" integer PRIMARY KEY NOT NULL,
	"namespace" uuid NOT NULL,
	CONSTRAINT "portability_identity_singleton" CHECK ("portability_identity"."id" = 1)
);
