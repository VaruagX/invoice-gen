/**
 * Append an entry to the account's activity history. Pass the transaction
 * client so the entry is committed (or rolled back) with the change it records.
 */
async function logActivity(db, userId, { entityType, entityId = null, action, summary, metadata = {} }) {
  await db.query(
    `INSERT INTO activity_logs (user_id, entity_type, entity_id, action, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, entityType, entityId, action, String(summary).slice(0, 300), JSON.stringify(metadata)]
  );
}

module.exports = { logActivity };
