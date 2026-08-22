export type ConnectedOrganization = {
  connectionId: string;
  sourceSlug: string;
  targetOrgId: string;
  targetSlug: string;
};

export function organizationPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}

export async function resolveConnectedOrganization(
  db: D1Database,
  sourceOrgId: string,
  targetSlug: string,
): Promise<ConnectedOrganization | null> {
  const row = await db
    .prepare(
      `SELECT c.id AS connection_id, source.slug AS source_slug,
              target.id AS target_org_id, target.slug AS target_slug
       FROM organization target
       JOIN organization source ON source.id = ?
       JOIN organization_connection c
         ON c.status = 'active'
        AND ((c.org_a_id = source.id AND c.org_b_id = target.id)
          OR (c.org_b_id = source.id AND c.org_a_id = target.id))
       WHERE target.slug = ? AND target.id != source.id
       LIMIT 1`,
    )
    .bind(sourceOrgId, targetSlug)
    .first<{
      connection_id: string;
      source_slug: string;
      target_org_id: string;
      target_slug: string;
    }>();
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    sourceSlug: row.source_slug,
    targetOrgId: row.target_org_id,
    targetSlug: row.target_slug,
  };
}

export async function organizationBySlug(
  db: D1Database,
  slug: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  return db
    .prepare("SELECT id, name, slug FROM organization WHERE slug = ? LIMIT 1")
    .bind(slug)
    .first<{ id: string; name: string; slug: string }>();
}

export async function organizationIdBySlug(
  db: D1Database,
  slug: string,
): Promise<string | null> {
  return (await organizationBySlug(db, slug))?.id ?? null;
}

export async function organizationConnectionIsActive(
  db: D1Database,
  connectionId: string,
): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        "SELECT 1 AS present FROM organization_connection WHERE id = ? AND status = 'active' LIMIT 1",
      )
      .bind(connectionId)
      .first<{ present: number }>(),
  );
}
