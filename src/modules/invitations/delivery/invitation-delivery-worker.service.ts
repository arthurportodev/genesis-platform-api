import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { InvitationRole } from '../enums/invitation.enums';
import {
  INVITATION_TOKEN_KEYRING,
  InvitationTokenKeyring,
} from '../ports/invitation-token-keyring.port';
import { InvitationTokenCodec } from '../services/invitation-token-codec.service';
import {
  INVITATION_EMAIL_DELIVERY,
  InvitationEmailDeliveryPort,
  InvitationEmailDeliveryResult,
} from './invitation-email-delivery.port';
import { InvitationEmailV1Renderer } from './invitation-email-v1.renderer';
import {
  InvitationWorkerObservability,
  InvitationWorkerOutcome,
} from './invitation-worker-observability.service';

interface ClaimedDelivery {
  id: string;
  invitationId: string;
  organizationId: string;
  attempts: number;
  createdAt: Date;
  lockedBy: string;
  emailNormalized: string;
  role: InvitationRole;
  expiresAt: Date;
  tokenKeyVersion: number;
  tokenVersion: number;
  tokenNonce: string;
  recovered: boolean;
}

@Injectable()
export class InvitationDeliveryWorkerService {
  private static readonly RETRY_CAPS_MS = [
    30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000,
  ];
  private readonly logger = new Logger(InvitationDeliveryWorkerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly codec: InvitationTokenCodec,
    @Inject(INVITATION_TOKEN_KEYRING)
    private readonly keyring: InvitationTokenKeyring,
    @Inject(INVITATION_EMAIL_DELIVERY)
    private readonly delivery: InvitationEmailDeliveryPort,
    private readonly renderer: InvitationEmailV1Renderer,
    private readonly observability: InvitationWorkerObservability = new InvitationWorkerObservability(),
  ) {}

  async processOnce(): Promise<InvitationWorkerOutcome> {
    const startedAt = Date.now();
    const maintenance = await this.maintain();
    for (let index = 0; index < maintenance.cancelled; index += 1)
      this.observability.count('cancelled');
    for (let index = 0; index < maintenance.dead; index += 1)
      this.observability.count('dead');
    const claim = await this.claim();
    if (claim === null) {
      const outcome = maintenance.cancelled ? 'cancelled' : 'idle';
      if (outcome === 'idle') this.observability.count('idle');
      this.observability.count('iteration', Date.now() - startedAt);
      return outcome;
    }
    this.observability.count('claims');
    if (claim.recovered) this.observability.count('recovered');
    let result: InvitationEmailDeliveryResult;
    let token: string;
    try {
      const persistedKey = this.keyring.keyFor(claim.tokenKeyVersion);
      if (persistedKey.length < 32) throw new Error('key unavailable');
      token = this.codec.issue({
        invitationId: claim.invitationId,
        keyVersion: claim.tokenKeyVersion,
        tokenVersion: claim.tokenVersion,
        organizationId: claim.organizationId,
        emailNormalized: claim.emailNormalized,
        role: claim.role,
        expiresAt: claim.expiresAt,
        nonce: claim.tokenNonce,
      });
    } catch {
      result = { kind: 'retry', errorCode: 'key_version_unavailable' };
      this.logger.warn(
        JSON.stringify({
          event: 'invitation_delivery_key_unavailable',
          deliveryId: claim.id,
          claimCorrelation: claim.lockedBy,
        }),
      );
      const outcome = await this.finalize(claim, result);
      this.observability.count('key_version_unavailable');
      this.observability.count(outcome, Date.now() - startedAt);
      return claim.recovered && outcome !== 'fenced_out'
        ? 'recovered'
        : outcome;
    }
    const providerStartedAt = Date.now();
    result = await this.delivery.send(
      this.renderer.render({
        outboxId: claim.id,
        recipientEmail: claim.emailNormalized,
        role: claim.role,
        token,
        expiresAt: claim.expiresAt,
      }),
    );
    this.observability.count('provider_call', Date.now() - providerStartedAt);
    const outcome = await this.finalize(claim, result);
    this.logger.log(
      JSON.stringify({
        event: 'invitation_delivery_finished',
        deliveryId: claim.id,
        claimCorrelation: claim.lockedBy,
        attempt: claim.attempts,
        outcome,
        errorCode:
          outcome === 'fenced_out' || result.kind === 'sent'
            ? null
            : result.errorCode,
      }),
    );
    this.observability.count(outcome, Date.now() - startedAt);
    if (result.kind === 'retry') {
      this.observability.count(this.providerMetric(result.errorCode));
    }
    return claim.recovered && outcome !== 'fenced_out' ? 'recovered' : outcome;
  }

  async refreshOperationalGauges(): Promise<void> {
    await this.observability.refreshGauges(this.dataSource);
  }

  async isKeyringReady(): Promise<boolean> {
    try {
      const rows = await this.dataSource.query<Array<{ keyVersion: number }>>(
        `SELECT DISTINCT invitation.token_key_version AS "keyVersion"
         FROM invitation_delivery_outbox AS delivery
         JOIN organization_invitations AS invitation
           ON invitation.id = delivery.invitation_id
          AND invitation.organization_id = delivery.organization_id
         WHERE delivery.status IN ('queued', 'processing')
           AND (delivery.attempts < 8
                OR delivery.last_error_code = 'key_version_unavailable')
           AND delivery.created_at + interval '23 hours' > transaction_timestamp()
           AND invitation.status = 'pending'
           AND invitation.expires_at > transaction_timestamp()
         ORDER BY invitation.token_key_version`,
      );
      for (const row of rows) {
        if (this.keyring.keyFor(row.keyVersion).length < 32) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async maintain(): Promise<{ cancelled: number; dead: number }> {
    return this.dataSource.transaction(async (manager) => {
      const cancelledResult = await manager.query<
        [Array<{ id: string }>, number]
      >(
        `WITH invalid AS (
           SELECT delivery.id
           FROM invitation_delivery_outbox AS delivery
           JOIN organization_invitations AS invitation
             ON invitation.id = delivery.invitation_id
            AND invitation.organization_id = delivery.organization_id
           WHERE delivery.status IN ('queued', 'processing', 'dead')
             AND invitation.status <> 'pending'
           ORDER BY delivery.created_at, delivery.id
           FOR UPDATE OF delivery SKIP LOCKED LIMIT 100
         ) UPDATE invitation_delivery_outbox AS delivery
           SET status = 'cancelled', cancelled_at = transaction_timestamp(),
               last_error_code = NULL, next_attempt_at = NULL,
               locked_by = NULL, locked_at = NULL, lease_until = NULL,
               updated_at = transaction_timestamp()
           FROM invalid WHERE delivery.id = invalid.id RETURNING delivery.id`,
      );
      const deadResult = await manager.query<[Array<{ id: string }>, number]>(
        `WITH stale AS (
           SELECT id FROM invitation_delivery_outbox
           WHERE (
             (status = 'queued'
               AND (created_at + interval '23 hours' <= transaction_timestamp()
                    OR (attempts >= 8
                        AND last_error_code IS DISTINCT FROM 'key_version_unavailable')))
             OR
             (status = 'processing' AND lease_until <= transaction_timestamp()
               AND (created_at + interval '23 hours' <= transaction_timestamp()
                    OR (attempts >= 8
                        AND last_error_code IS DISTINCT FROM 'key_version_unavailable')))
           )
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
         ) UPDATE invitation_delivery_outbox AS delivery
           SET status = 'dead',
               last_error_code = CASE
                 WHEN delivery.last_error_code = 'key_version_unavailable'
                   THEN 'key_version_unavailable_deadline_exceeded'
                 ELSE 'delivery_deadline_exceeded'
               END,
               locked_by = NULL, locked_at = NULL, lease_until = NULL,
               next_attempt_at = NULL, updated_at = transaction_timestamp()
           FROM stale WHERE delivery.id = stale.id RETURNING delivery.id`,
      );
      await manager.query(
        `WITH sent_rows AS (
           SELECT id FROM invitation_delivery_outbox
           WHERE status = 'sent' AND provider_message_id IS NOT NULL
             AND sent_at < transaction_timestamp() - interval '30 days'
           ORDER BY sent_at, id FOR UPDATE SKIP LOCKED LIMIT 100
         ) UPDATE invitation_delivery_outbox AS delivery
           SET provider_message_id = NULL, updated_at = transaction_timestamp()
           FROM sent_rows WHERE delivery.id = sent_rows.id`,
      );
      await manager.query(
        `WITH dead_rows AS (
           SELECT id FROM invitation_delivery_outbox
           WHERE status = 'dead' AND last_error_code IS NOT NULL
             AND updated_at < transaction_timestamp() - interval '90 days'
           ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT 100
         ) UPDATE invitation_delivery_outbox AS delivery
           SET last_error_code = NULL, updated_at = transaction_timestamp()
           FROM dead_rows WHERE delivery.id = dead_rows.id`,
      );
      return {
        cancelled: cancelledResult[0].length,
        dead: deadResult[0].length,
      };
    });
  }

  private async claim(): Promise<ClaimedDelivery | null> {
    return this.dataSource.transaction(async (manager) => {
      const lockedBy = randomUUID();
      const rows = await manager.query<ClaimedDelivery[]>(
        `WITH candidate AS (
           SELECT delivery.id, delivery.status AS prior_status
           FROM invitation_delivery_outbox AS delivery
           JOIN organization_invitations AS invitation
             ON invitation.id = delivery.invitation_id
            AND invitation.organization_id = delivery.organization_id
           WHERE ((delivery.status = 'queued'
                    AND COALESCE(delivery.next_attempt_at, delivery.created_at) <= transaction_timestamp())
                  OR (delivery.status = 'processing'
                    AND delivery.lease_until <= transaction_timestamp()))
             AND (delivery.attempts < 8
                  OR delivery.last_error_code = 'key_version_unavailable')
             AND delivery.created_at + interval '23 hours' > transaction_timestamp()
             AND invitation.status = 'pending'
             AND invitation.expires_at > transaction_timestamp()
           ORDER BY COALESCE(delivery.next_attempt_at, delivery.created_at),
                    delivery.created_at, delivery.id
           FOR UPDATE OF delivery SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE invitation_delivery_outbox AS delivery
           SET status = 'processing', attempts = attempts + 1,
               locked_by = $1, locked_at = transaction_timestamp(),
               lease_until = transaction_timestamp() + interval '60 seconds',
               next_attempt_at = NULL, updated_at = transaction_timestamp()
           FROM candidate WHERE delivery.id = candidate.id
           RETURNING delivery.*
         )
         SELECT claimed.id, claimed.invitation_id AS "invitationId",
                claimed.organization_id AS "organizationId", claimed.attempts,
                claimed.created_at AS "createdAt", claimed.locked_by AS "lockedBy",
                invitation.email_normalized AS "emailNormalized", invitation.role,
                invitation.expires_at AS "expiresAt",
                invitation.token_key_version AS "tokenKeyVersion",
                invitation.token_version AS "tokenVersion",
                invitation.token_nonce AS "tokenNonce",
                candidate.prior_status = 'processing' AS recovered
         FROM claimed JOIN candidate ON candidate.id = claimed.id
         JOIN organization_invitations AS invitation
           ON invitation.id = claimed.invitation_id
          AND invitation.organization_id = claimed.organization_id`,
        [lockedBy],
      );
      return rows[0] ?? null;
    });
  }

  private async finalize(
    claim: ClaimedDelivery,
    result: InvitationEmailDeliveryResult,
  ): Promise<InvitationWorkerOutcome> {
    return this.dataSource.transaction(async (manager) => {
      if (result.kind === 'sent') {
        const updated = await this.fencedUpdate(
          manager,
          claim,
          `status = 'sent', provider_message_id = $3,
           sent_at = transaction_timestamp(), last_error_code = NULL,
           locked_by = NULL, locked_at = NULL, lease_until = NULL,
           next_attempt_at = NULL, updated_at = transaction_timestamp()`,
          [result.providerMessageId],
        );
        return updated ? 'sent' : 'fenced_out';
      }
      const deadline = Math.min(
        claim.expiresAt.getTime(),
        claim.createdAt.getTime() + 23 * 60 * 60 * 1000,
      );
      const [clock] = await manager.query<Array<{ now: Date }>>(
        'SELECT transaction_timestamp() AS now',
      );
      if (clock === undefined) throw new Error('database clock unavailable');
      const databaseNow = clock.now.getTime();
      const cap =
        InvitationDeliveryWorkerService.RETRY_CAPS_MS[
          Math.min(
            claim.attempts - 1,
            InvitationDeliveryWorkerService.RETRY_CAPS_MS.length - 1,
          )
        ] ?? 30_000;
      const retryAt =
        result.kind === 'retry'
          ? result.retryAfterAtMs === undefined
            ? databaseNow +
              (result.retryAfterMs ?? Math.floor(Math.random() * cap))
            : Math.max(
                databaseNow,
                Math.min(result.retryAfterAtMs, databaseNow + 86_400_000),
              )
          : deadline;
      const isKeyUnavailable =
        result.kind === 'retry' &&
        result.errorCode === 'key_version_unavailable';
      const retryable =
        result.kind === 'retry' &&
        databaseNow < deadline &&
        (isKeyUnavailable || (claim.attempts < 8 && retryAt < deadline));
      if (retryable) {
        const updated = await this.fencedUpdate(
          manager,
          claim,
          `status = 'queued', last_error_code = $3, next_attempt_at = $4,
           locked_by = NULL, locked_at = NULL, lease_until = NULL,
           updated_at = transaction_timestamp()`,
          [result.errorCode, new Date(Math.min(retryAt, deadline))],
        );
        return updated ? 'retry_scheduled' : 'fenced_out';
      } else {
        const deadErrorCode =
          result.errorCode === 'key_version_unavailable'
            ? 'key_version_unavailable_deadline_exceeded'
            : result.errorCode;
        const updated = await this.fencedUpdate(
          manager,
          claim,
          `status = 'dead', last_error_code = $3, next_attempt_at = NULL,
           locked_by = NULL, locked_at = NULL, lease_until = NULL,
           updated_at = transaction_timestamp()`,
          [deadErrorCode],
        );
        return updated ? 'dead' : 'fenced_out';
      }
    });
  }

  private async fencedUpdate(
    manager: EntityManager,
    claim: ClaimedDelivery,
    assignment: string,
    values: unknown[],
  ): Promise<boolean> {
    const result = await manager.query<[Array<{ id: string }>, number]>(
      `UPDATE invitation_delivery_outbox SET ${assignment}
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
         AND lease_until > transaction_timestamp()
       RETURNING id`,
      [claim.id, claim.lockedBy, ...values],
    );
    return result[0].length > 0;
  }

  private providerMetric(errorCode: string): string {
    if (errorCode === 'provider_timeout') return 'provider_timeout';
    if (errorCode === 'provider_rate_limited') return 'provider_429';
    if (errorCode === 'provider_unavailable') return 'provider_5xx';
    if (errorCode === 'provider_network_error') return 'provider_network';
    return 'provider_other_failure';
  }
}
