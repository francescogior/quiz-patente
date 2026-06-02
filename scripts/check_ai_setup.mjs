import { readFile } from "node:fs/promises";

const env = parseDotEnv(await readFile(".env.local", "utf8"));
const url = `${env.SUPABASE_URL?.replace(/\/$/, "")}/rest/v1/question_explanations?select=question_id&limit=1`;

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const response = await fetch(url, {
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  },
});

if (!response.ok) {
  console.error("Supabase AI tables are not reachable. Run supabase/schema.sql in Supabase SQL Editor.");
  process.exit(1);
}

console.log("Supabase AI tables are reachable.");

function parseDotEnv(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
