import { DataSource } from 'typeorm';
import dataSource from '../data-source';
import { Membership } from '../../modules/memberships/entities/membership.entity';
import { MembershipRole } from '../../modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../modules/memberships/enums/membership-status.enum';
import { Organization } from '../../modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../../modules/organizations/enums/organization-status.enum';
import { User } from '../../modules/users/entities/user.entity';
import { UserStatus } from '../../modules/users/enums/user-status.enum';

export interface SeedLogger {
  log(message: string): void;
}

export interface InitialTenantSeedResult {
  userCreated: boolean;
  organizationCreated: boolean;
  membershipCreated: boolean;
  userId: string;
  organizationId: string;
  membershipId: string;
}

const INITIAL_USER_EMAIL = 'contato@agenciagenesismkt.com.br';
const INITIAL_USER_NAME = 'Arthur Porto';
const INITIAL_ORGANIZATION_NAME = 'Agência Gênesis';
const INITIAL_ORGANIZATION_SLUG = 'agencia-genesis';

export async function seedInitialTenant(
  connection: DataSource,
  logger: SeedLogger = console,
): Promise<InitialTenantSeedResult> {
  return connection.transaction(async (manager) => {
    const users = manager.getRepository(User);
    const organizations = manager.getRepository(Organization);
    const memberships = manager.getRepository(Membership);
    const normalizedEmail = INITIAL_USER_EMAIL.trim().toLowerCase();

    let user = await users.findOneBy({ email: normalizedEmail });
    let userCreated = false;
    if (user === null) {
      userCreated = true;
      user = await users.save(
        users.create({
          email: normalizedEmail,
          name: INITIAL_USER_NAME,
          status: UserStatus.ACTIVE,
        }),
      );
    }

    let organization = await organizations.findOneBy({
      slug: INITIAL_ORGANIZATION_SLUG,
    });
    let organizationCreated = false;
    if (organization === null) {
      organizationCreated = true;
      organization = await organizations.save(
        organizations.create({
          name: INITIAL_ORGANIZATION_NAME,
          slug: INITIAL_ORGANIZATION_SLUG,
          status: OrganizationStatus.ACTIVE,
        }),
      );
    }

    let membership = await memberships.findOneBy({
      userId: user.id,
      organizationId: organization.id,
    });
    let membershipCreated = false;
    if (membership === null) {
      membershipCreated = true;
      membership = await memberships.save(
        memberships.create({
          userId: user.id,
          organizationId: organization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
      );
    }

    const result: InitialTenantSeedResult = {
      userCreated,
      organizationCreated,
      membershipCreated,
      userId: user.id,
      organizationId: organization.id,
      membershipId: membership.id,
    };

    logger.log(
      [
        'Initial tenant seed completed.',
        `User: ${userCreated ? 'created' : 'already existed'}.`,
        `Organization: ${organizationCreated ? 'created' : 'already existed'}.`,
        `Membership: ${membershipCreated ? 'created' : 'already existed'}.`,
      ].join(' '),
    );

    return result;
  });
}

async function run(): Promise<void> {
  let initializedHere = false;
  try {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
      initializedHere = true;
    }
    await seedInitialTenant(dataSource);
  } finally {
    if (initializedHere && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Initial tenant seed failed: ${message}`);
    process.exitCode = 1;
  });
}
