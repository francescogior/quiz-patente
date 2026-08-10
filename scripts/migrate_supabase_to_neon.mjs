import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import { neon } from "@neondatabase/serverless";

const required = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_SECRET",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
console.log("Migration preflight complete.");

const target = neon(process.env.DATABASE_URL);
const sourceUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const sourceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sourceHeaders = { apikey: sourceKey, Authorization: `Bearer ${sourceKey}` };

function sourceRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode || 500;
        if (status < 200 || status >= 300) {
          const error = new Error(body || `Source request failed with ${status}`);
          error.statusCode = status;
          reject(error);
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(20_000, () => request.destroy(new Error("Source request timed out")));
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function applySchema() {
  const schema = await fs.readFile(new URL("../neon/schema.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";").map((value) => value.trim()).filter(Boolean)) {
    await target.query(statement);
  }
  console.log("Neon schema ready.");
}

async function fetchRows(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${sourceUrl}/rest/v1/${table}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", String(offset));
    const page = await sourceRequest(url, { headers: sourceHeaders });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function upsertRows(table, rows, conflictColumns) {
  for (const original of rows) {
    const row = { ...original };
    const columns = Object.keys(row);
    const values = columns.map((column) =>
      ["answers", "explanation_meta"].includes(column)
        ? JSON.stringify(row[column] ?? (column === "answers" ? [] : {}))
        : row[column],
    );
    const placeholders = columns.map((column, index) =>
      ["answers", "explanation_meta"].includes(column) ? `$${index + 1}::jsonb` : `$${index + 1}`,
    );
    const updates = columns
      .filter((column) => !conflictColumns.includes(column))
      .map((column) => `${column} = excluded.${column}`);
    await target.query(
      `insert into ${table} (${columns.join(", ")}) values (${placeholders.join(", ")})
       on conflict (${conflictColumns.join(", ")}) do ${
         updates.length ? `update set ${updates.join(", ")}` : "nothing"
       }`,
      values,
    );
  }
}

async function listStorageObjects(bucket, prefix = "") {
  let entries;
  try {
    entries = await sourceRequest(`${sourceUrl}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { ...sourceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
    });
  } catch (error) {
    if (error.statusCode === 404) return [];
    throw error;
  }
  const objects = [];
  for (const entry of entries) {
    const objectKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!entry.metadata) objects.push(...(await listStorageObjects(bucket, objectKey)));
    else objects.push(objectKey);
  }
  return objects;
}

async function readStorageObject(bucket, objectKey) {
  const encoded = objectKey.split("/").map(encodeURIComponent).join("/");
  try {
    return await sourceRequest(`${sourceUrl}/storage/v1/object/authenticated/${bucket}/${encoded}`, {
      headers: sourceHeaders,
    });
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function writeKv(namespace, objectKey, payload) {
  await target.query(
    `insert into app_kv_objects (namespace, object_key, payload)
     values ($1, $2, $3::jsonb)
     on conflict (namespace, object_key) do update
       set payload = excluded.payload, updated_at = now()`,
    [namespace, objectKey, JSON.stringify(payload)],
  );
}

function entitlementKey(secret, user) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${user.id}:${String(user.email).trim().toLowerCase()}`)
    .digest("hex");
  return `accounts/${digest}.json`;
}

await applySchema();

const tablePlan = [
  ["app_users", ["email"]],
  ["question_explanations", ["question_id"]],
  ["explanation_reports", ["id"]],
  ["user_exam_results", ["user_id", "exam_id"]],
];
const counts = {};
let users = [];
for (const [table, conflicts] of tablePlan) {
  const rows = await fetchRows(table);
  if (table === "app_users") users = rows;
  await upsertRows(table, rows, conflicts);
  counts[table] = rows.length;
  console.log(`Migrated ${table}: ${rows.length}`);
}

await target.query(
  `select setval(pg_get_serial_sequence('explanation_reports', 'id'),
                 greatest(coalesce((select max(id) from explanation_reports), 1), 1), true)`,
);

const translations = await listStorageObjects("question-translations");
for (const objectKey of translations) {
  const payload = await readStorageObject("question-translations", objectKey);
  if (payload) await writeKv("question-translations", objectKey, payload);
}
counts["question-translations"] = translations.length;
console.log(`Migrated question-translations: ${translations.length}`);

let entitlements = 0;
for (const user of users) {
  const oldKey = entitlementKey(sourceKey, user);
  const payload = await readStorageObject("quizpatente-plus-entitlements", oldKey);
  if (!payload) continue;
  await writeKv("quizpatente-plus-entitlements", entitlementKey(process.env.APP_SECRET, user), payload);
  entitlements += 1;
}
counts["quizpatente-plus-entitlements"] = entitlements;
console.log(`Migrated quizpatente-plus-entitlements: ${entitlements}`);

const verified = await target.query(
  `select
     (select count(*)::int from app_users) as users,
     (select count(*)::int from user_exam_results) as results,
     (select count(*)::int from question_explanations) as explanations,
     (select count(*)::int from app_kv_objects) as kv_objects`,
);

console.log(JSON.stringify({ migrated: counts, target: verified[0] }, null, 2));
