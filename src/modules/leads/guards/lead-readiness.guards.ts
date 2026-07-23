import { CanActivate, Inject, Injectable } from '@nestjs/common';
import { LEAD_READINESS, LeadReadiness } from '../ports/lead-readiness.port';

@Injectable()
export class ManualLeadReadinessGuard implements CanActivate {
  constructor(
    @Inject(LEAD_READINESS) private readonly readiness: LeadReadiness,
  ) {}

  async canActivate(): Promise<boolean> {
    await this.readiness.assertManualReady();
    return true;
  }
}

@Injectable()
export class FormLeadReadinessGuard implements CanActivate {
  constructor(
    @Inject(LEAD_READINESS) private readonly readiness: LeadReadiness,
  ) {}

  async canActivate(): Promise<boolean> {
    await this.readiness.assertFormReady();
    return true;
  }
}
