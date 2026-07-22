import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type InvitationWorkerOutcome =
  | 'sent'
  | 'retry_scheduled'
  | 'dead'
  | 'cancelled'
  | 'fenced_out'
  | 'recovered'
  | 'idle';

@Injectable()
export class InvitationWorkerObservability {
  private readonly logger = new Logger(InvitationWorkerObservability.name);
  private readonly counters = new Map<string, number>();
  private gauges: Record<string, number> = {};

  count(name: string, durationMs?: number): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
    this.logger.log(
      JSON.stringify({
        event: 'invitation_worker_metric',
        metric: name,
        count: this.counters.get(name),
        ...(durationMs === undefined ? {} : { durationMs }),
      }),
    );
  }

  async refreshGauges(dataSource: DataSource): Promise<void> {
    const [row] = await dataSource.query<
      Array<{
        backlogDue: number;
        oldestDueAgeSeconds: number;
        activeLeases: number;
        expiredLeases: number;
      }>
    >(
      `SELECT
         count(*) FILTER (WHERE status = 'queued' AND COALESCE(next_attempt_at, created_at) <= transaction_timestamp())::int AS "backlogDue",
         COALESCE(EXTRACT(EPOCH FROM transaction_timestamp() - min(COALESCE(next_attempt_at, created_at)) FILTER (WHERE status = 'queued' AND COALESCE(next_attempt_at, created_at) <= transaction_timestamp())), 0)::float AS "oldestDueAgeSeconds",
         count(*) FILTER (WHERE status = 'processing' AND lease_until > transaction_timestamp())::int AS "activeLeases",
         count(*) FILTER (WHERE status = 'processing' AND lease_until <= transaction_timestamp())::int AS "expiredLeases"
       FROM invitation_delivery_outbox`,
    );
    this.gauges = row ?? {};
  }

  snapshot(): Readonly<{
    counters: Record<string, number>;
    gauges: Record<string, number>;
  }> {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: { ...this.gauges },
    };
  }
}
