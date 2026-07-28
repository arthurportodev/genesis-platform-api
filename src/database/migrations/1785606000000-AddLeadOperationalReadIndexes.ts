import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLeadOperationalReadIndexes1785606000000 implements MigrationInterface {
  name = 'AddLeadOperationalReadIndexes1785606000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [encoding] = (await queryRunner.query(
      `SELECT current_setting('server_encoding') AS encoding`,
    )) as Array<{ encoding: string }>;
    if (encoding?.encoding !== 'UTF8') {
      throw new Error('CRM operational search requires UTF8 server encoding.');
    }

    await queryRunner.query(`CREATE INDEX IDX_leads_org_display_name_search
      ON public.leads (
        organization_id,
        (lower(normalize(display_name, NFC))) text_pattern_ops,
        created_at DESC,
        id DESC
      )`);
    await queryRunner.query(`CREATE INDEX IDX_leads_org_company_name_search
      ON public.leads (
        organization_id,
        (lower(normalize(company_name, NFC))) text_pattern_ops,
        created_at DESC,
        id DESC
      ) WHERE company_name IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IDX_leads_org_email_search
      ON public.leads (
        organization_id,
        (lower(normalize(email, NFC))) text_pattern_ops,
        created_at DESC,
        id DESC
      ) WHERE email IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IDX_lead_entries_org_received
      ON public.lead_entries (organization_id, received_at DESC, lead_id, sequence DESC)`);
    await queryRunner.query(`CREATE INDEX IDX_lead_entries_org_initial_source
      ON public.lead_entries (organization_id, source, lead_id)
      WHERE sequence = 1`);
    await queryRunner.query(`CREATE INDEX IDX_lead_next_actions_org_pending_due
      ON public.lead_next_actions (organization_id, due_at, lead_id)
      WHERE status = 'pending'`);
    await queryRunner.query(`CREATE INDEX IDX_lead_next_actions_org_responsible_pending_due
      ON public.lead_next_actions (
        organization_id, responsible_membership_id, due_at, lead_id
      ) WHERE status = 'pending'`);
    await queryRunner.query(`CREATE INDEX IDX_lead_return_reviews_org_pending_opened
      ON public.lead_return_reviews (organization_id, opened_at, id, lead_id)
      WHERE status = 'pending'`);
    await queryRunner.query(`CREATE INDEX IDX_lead_cycles_org_closed_status
      ON public.lead_commercial_cycles (
        organization_id, closed_at, closing_status, lead_id
      ) WHERE closed_at IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX public.IDX_lead_cycles_org_closed_status',
    );
    await queryRunner.query(
      'DROP INDEX public.IDX_lead_return_reviews_org_pending_opened',
    );
    await queryRunner.query(
      'DROP INDEX public.IDX_lead_next_actions_org_responsible_pending_due',
    );
    await queryRunner.query(
      'DROP INDEX public.IDX_lead_next_actions_org_pending_due',
    );
    await queryRunner.query(
      'DROP INDEX public.IDX_lead_entries_org_initial_source',
    );
    await queryRunner.query('DROP INDEX public.IDX_lead_entries_org_received');
    await queryRunner.query('DROP INDEX public.IDX_leads_org_email_search');
    await queryRunner.query(
      'DROP INDEX public.IDX_leads_org_company_name_search',
    );
    await queryRunner.query(
      'DROP INDEX public.IDX_leads_org_display_name_search',
    );
  }
}
