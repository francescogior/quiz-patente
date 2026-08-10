const { query } = require("./db");

async function readJson(namespace, objectKey) {
  const rows = await query(
    `select payload
       from app_kv_objects
      where namespace = $1 and object_key = $2
      limit 1`,
    [namespace, objectKey],
  );
  return rows[0]?.payload ?? null;
}

async function writeJson(namespace, objectKey, payload) {
  await query(
    `insert into app_kv_objects (namespace, object_key, payload)
     values ($1, $2, $3::jsonb)
     on conflict (namespace, object_key) do update
       set payload = excluded.payload, updated_at = now()`,
    [namespace, objectKey, JSON.stringify(payload)],
  );
}

async function claimJson(namespace, objectKey, payload) {
  const rows = await query(
    `insert into app_kv_objects (namespace, object_key, payload)
     values ($1, $2, $3::jsonb)
     on conflict (namespace, object_key) do nothing
     returning object_key`,
    [namespace, objectKey, JSON.stringify(payload)],
  );
  return rows.length > 0;
}

async function deleteJson(namespace, objectKey) {
  await query(
    `delete from app_kv_objects where namespace = $1 and object_key = $2`,
    [namespace, objectKey],
  );
}

module.exports = { claimJson, deleteJson, readJson, writeJson };
