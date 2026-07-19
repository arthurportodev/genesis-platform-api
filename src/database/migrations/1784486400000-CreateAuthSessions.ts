import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthSessions1784486400000 implements MigrationInterface {
  name = 'CreateAuthSessions1784486400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "users" ADD "password_hash" varchar(255)',
    );
    await queryRunner.query(
      'ALTER TABLE "users" ADD "password_changed_at" timestamptz',
    );
    await queryRunner.query(
      "CREATE TYPE \"auth_session_status_enum\" AS ENUM ('active', 'revoked')",
    );
    await queryRunner.query(
      "CREATE TYPE \"auth_refresh_token_status_enum\" AS ENUM ('active', 'consumed', 'revoked')",
    );

    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "status" "auth_session_status_enum" NOT NULL DEFAULT 'active',
        "expires_at" timestamptz NOT NULL,
        "last_used_at" timestamptz,
        "revoked_at" timestamptz,
        "revoke_reason" varchar(64),
        "user_agent" varchar(512),
        "ip_address" inet,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "CHK_auth_sessions_revocation_state"
          CHECK (
            ("status" = 'active' AND "revoked_at" IS NULL)
            OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
          )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_sessions_user_id" ON "auth_sessions" ("user_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_sessions_status" ON "auth_sessions" ("status")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_sessions_expires_at" ON "auth_sessions" ("expires_at")',
    );

    await queryRunner.query(`
      CREATE TABLE "auth_refresh_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "session_id" uuid NOT NULL,
        "token_hash" varchar(64) NOT NULL,
        "status" "auth_refresh_token_status_enum" NOT NULL DEFAULT 'active',
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "revoked_at" timestamptz,
        "replaced_by_token_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_auth_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_auth_refresh_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "UQ_auth_refresh_tokens_replaced_by_token_id"
          UNIQUE ("replaced_by_token_id"),
        CONSTRAINT "FK_auth_refresh_tokens_session"
          FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "FK_auth_refresh_tokens_replacement"
          FOREIGN KEY ("replaced_by_token_id") REFERENCES "auth_refresh_tokens"("id")
          ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "CHK_auth_refresh_tokens_token_hash"
          CHECK ("token_hash" ~ '^[a-f0-9]{64}$'),
        CONSTRAINT "CHK_auth_refresh_tokens_state"
          CHECK (
            ("status" = 'active' AND "consumed_at" IS NULL AND "revoked_at" IS NULL)
            OR ("status" = 'consumed' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL)
            OR ("status" = 'revoked' AND "consumed_at" IS NULL AND "revoked_at" IS NOT NULL)
          )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_refresh_tokens_session_id" ON "auth_refresh_tokens" ("session_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_refresh_tokens_status" ON "auth_refresh_tokens" ("status")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_refresh_tokens_expires_at" ON "auth_refresh_tokens" ("expires_at")',
    );

    await queryRunner.query(`
      CREATE TABLE "auth_audit_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid,
        "session_id" uuid,
        "event_type" varchar(64) NOT NULL,
        "ip_address" inet,
        "user_agent" varchar(512),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_auth_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_audit_logs_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "FK_auth_audit_logs_session"
          FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
          ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "CHK_auth_audit_logs_event_type"
          CHECK ("event_type" IN (
            'auth.login.succeeded',
            'auth.login.failed',
            'auth.refresh.succeeded',
            'auth.refresh.failed',
            'auth.refresh.reuse_detected',
            'auth.logout',
            'auth.logout_all'
          ))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_audit_logs_user_id" ON "auth_audit_logs" ("user_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_audit_logs_event_type" ON "auth_audit_logs" ("event_type")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_auth_audit_logs_created_at" ON "auth_audit_logs" ("created_at")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_audit_logs_created_at"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_audit_logs_event_type"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_audit_logs_user_id"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "auth_audit_logs"');
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_refresh_tokens_expires_at"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_refresh_tokens_status"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_refresh_tokens_session_id"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "auth_refresh_tokens"');
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_sessions_expires_at"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_sessions_status"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "public"."IDX_auth_sessions_user_id"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "auth_sessions"');
    await queryRunner.query(
      'DROP TYPE IF EXISTS "auth_refresh_token_status_enum"',
    );
    await queryRunner.query('DROP TYPE IF EXISTS "auth_session_status_enum"');
    await queryRunner.query(
      'ALTER TABLE "users" DROP COLUMN "password_changed_at"',
    );
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "password_hash"');
  }
}
