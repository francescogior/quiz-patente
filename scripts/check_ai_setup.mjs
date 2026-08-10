import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const fileEnv = await readFile(".env.local", "utf8").then(parseDotEnv).catch(() => ({}));
const env = { ...fileEnv, ...process.env };
const tables = [
  ["question_explanations", "question_id"],
  ["explanation_reports", "id"],
  ["app_users", "id"],
  ["app_login_codes", "id"],
  ["app_sessions", "id"],
  ["user_exam_results", "id"],
];

if (!env.DATABASE_URL || !env.APP_SECRET) {
  console.error("Missing DATABASE_URL or APP_SECRET in .env.local");
  process.exit(1);
}

const sql = neon(env.DATABASE_URL);
for (const [table, column] of tables) {
  try {
    await sql.query(`select ${column} from ${table} limit 1`);
  } catch (error) {
    console.error(`Neon table "${table}" is not reachable. Apply neon/schema.sql.`, error.message);
    process.exit(1);
  }
}

console.log("Neon backend tables are reachable.");

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
