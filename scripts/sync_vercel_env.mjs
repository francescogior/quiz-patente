import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const REQUIRED_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
  "REPORT_EMAIL_TO",
  "EMAIL_FROM",
  "OPENAI_MODEL",
];

const env = parseDotEnv(await readFile(".env.local", "utf8"));
const missing = REQUIRED_KEYS.filter((key) => !env[key]);

if (missing.length > 0) {
  console.error(`Missing values in .env.local: ${missing.join(", ")}`);
  process.exit(1);
}

for (const key of REQUIRED_KEYS) {
  await run("vercel", ["env", "rm", key, "production", "--yes"], { ignoreFailure: true });
  await run("vercel", ["env", "add", key, "production"], { stdin: `${env[key]}\n` });
  console.log(`Synced ${key} to Vercel production`);
}

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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.ignoreFailure) {
        reject(new Error(output.trim() || `${command} ${args.join(" ")} failed`));
        return;
      }
      resolve(output);
    });

    if (options.stdin) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}
