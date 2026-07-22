import { CanActivate, Inject, Injectable } from '@nestjs/common';
import {
  MEMBERSHIP_READINESS,
  MembershipReadiness,
} from '../ports/membership-readiness.port';

@Injectable()
export class MembershipReadinessGuard implements CanActivate {
  constructor(
    @Inject(MEMBERSHIP_READINESS)
    private readonly readiness: MembershipReadiness,
  ) {}

  async canActivate(): Promise<boolean> {
    await this.readiness.assertReady();
    return true;
  }
}
