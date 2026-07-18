import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMultiTenantCore1784400000000 implements MigrationInterface {
  name = 'CreateMultiTenantCore1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await queryRunner.query(
      "CREATE TYPE \"user_status_enum\" AS ENUM ('active', 'inactive')",
    );
    await queryRunner.query(
      "CREATE TYPE \"organization_status_enum\" AS ENUM ('active', 'inactive')",
    );
    await queryRunner.query(
      "CREATE TYPE \"membership_role_enum\" AS ENUM ('owner', 'admin', 'member')",
    );
    await queryRunner.query(
      "CREATE TYPE \"membership_status_enum\" AS ENUM ('active', 'inactive')",
    );

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar(320) NOT NULL,
        "name" varchar(160) NOT NULL,
        "status" "user_status_enum" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "CHK_users_email_normalized"
          CHECK ("email" = lower(btrim("email"))),
        CONSTRAINT "CHK_users_name_trimmed"
          CHECK ("name" = btrim("name") AND length("name") > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar(160) NOT NULL,
        "slug" varchar(120) NOT NULL,
        "status" "organization_status_enum" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_organizations_slug" UNIQUE ("slug"),
        CONSTRAINT "CHK_organizations_name_trimmed"
          CHECK ("name" = btrim("name") AND length("name") > 0),
        CONSTRAINT "CHK_organizations_slug_format"
          CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "memberships" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "role" "membership_role_enum" NOT NULL,
        "status" "membership_status_enum" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_memberships" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_memberships_user_organization"
          UNIQUE ("user_id", "organization_id"),
        CONSTRAINT "FK_memberships_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "FK_memberships_organization"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(
      'CREATE INDEX "IDX_memberships_user_id" ON "memberships" ("user_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_memberships_organization_id" ON "memberships" ("organization_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_memberships_organization_status" ON "memberships" ("organization_id", "status")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "memberships" DROP CONSTRAINT "FK_memberships_organization"',
    );
    await queryRunner.query(
      'ALTER TABLE "memberships" DROP CONSTRAINT "FK_memberships_user"',
    );
    await queryRunner.query(
      'DROP INDEX "public"."IDX_memberships_organization_status"',
    );
    await queryRunner.query(
      'DROP INDEX "public"."IDX_memberships_organization_id"',
    );
    await queryRunner.query('DROP INDEX "public"."IDX_memberships_user_id"');
    await queryRunner.query('DROP TABLE "memberships"');
    await queryRunner.query('DROP TABLE "organizations"');
    await queryRunner.query('DROP TABLE "users"');
    await queryRunner.query('DROP TYPE "membership_status_enum"');
    await queryRunner.query('DROP TYPE "membership_role_enum"');
    await queryRunner.query('DROP TYPE "organization_status_enum"');
    await queryRunner.query('DROP TYPE "user_status_enum"');

    // pgcrypto may be shared by other schemas, so rollback deliberately keeps it.
  }
}
