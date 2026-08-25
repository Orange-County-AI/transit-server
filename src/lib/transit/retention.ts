const DAY_MS = 24 * 60 * 60 * 1_000;

export type SweepResult = {
  batches: number;
  deleted: number;
};

type DeleteJob = {
  statement: string;
  cutoff: number;
};

export async function sweep(
  database: D1Database,
  options: {
    now?: number;
    batchSize?: number;
    maxBatches?: number;
  } = {},
): Promise<SweepResult> {
  const now = options.now ?? Date.now();
  const batchSize = options.batchSize ?? 1_000;
  const maxBatches = options.maxBatches ?? 50;
  if (batchSize < 1 || maxBatches < 1) {
    throw new Error("retention bounds must be positive");
  }
  const jobs: DeleteJob[] = [
    {
      cutoff: now - 7 * DAY_MS,
      statement: `DELETE FROM message_delivery
        WHERE rowid IN (
          SELECT d.rowid FROM message_delivery d
          JOIN message m ON m.id = d.message_id
          WHERE m.created_at < ? LIMIT ?
        )`,
    },
    {
      cutoff: now - 7 * DAY_MS,
      statement:
        "DELETE FROM message WHERE rowid IN (SELECT rowid FROM message WHERE created_at < ? LIMIT ?)",
    },
    {
      cutoff: now - 30 * DAY_MS,
      statement: `DELETE FROM integration_reply
        WHERE rowid IN (
          SELECT r.rowid FROM integration_reply r
          JOIN integration_delivery d ON d.id = r.delivery_id
          WHERE d.status IN ('handled', 'dead') AND d.created_at < ? LIMIT ?
        )`,
    },
    {
      cutoff: now - 30 * DAY_MS,
      statement: `DELETE FROM integration_delivery
        WHERE rowid IN (
          SELECT rowid FROM integration_delivery
          WHERE status IN ('handled', 'dead') AND created_at < ? LIMIT ?
        )`,
    },
    {
      cutoff: now - 30 * DAY_MS,
      statement: `DELETE FROM integration_event
        WHERE rowid IN (
          SELECT e.rowid FROM integration_event e
          LEFT JOIN integration_delivery d ON d.event_id = e.id
          WHERE d.id IS NULL AND e.received_at < ? LIMIT ?
        )`,
    },
    {
      cutoff: now,
      statement:
        "DELETE FROM enroll_code WHERE rowid IN (SELECT rowid FROM enroll_code WHERE expires_at < ? LIMIT ?)",
    },
    {
      // Expired device flows are dropped on the same pass. A user code is only
      // unique while it lives, so leaving dead rows behind would eventually
      // starve the code space.
      cutoff: now,
      statement:
        "DELETE FROM device_authorization WHERE rowid IN (SELECT rowid FROM device_authorization WHERE expires_at < ? LIMIT ?)",
    },
  ];

  let batches = 0;
  let deleted = 0;
  while (batches < maxBatches) {
    let roundDeleted = 0;
    for (const job of jobs) {
      if (batches >= maxBatches) break;
      const result = await database
        .prepare(job.statement)
        .bind(job.cutoff, batchSize)
        .run();
      const changes = result.meta.changes;
      batches += 1;
      deleted += changes;
      roundDeleted += changes;
    }
    if (roundDeleted === 0) break;
  }
  return { batches, deleted };
}
