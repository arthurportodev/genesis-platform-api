import { CanActivate, Inject, Injectable } from '@nestjs/common';
import {
  ORGANIZATION_CREATION_READINESS,
  OrganizationCreationReadiness,
} from '../ports/organization-creation-readiness.port';

@Injectable()
export class OrganizationCreationReadinessGuard implements CanActivate {
  constructor(
    @Inject(ORGANIZATION_CREATION_READINESS)
    private readonly readiness: OrganizationCreationReadiness,
  ) {}

  async canActivate(): Promise<boolean> {
    await this.readiness.assertReady();
    return true;
  }
}
