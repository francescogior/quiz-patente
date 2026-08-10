const { neon } = require("@neondatabase/serverless");

let client = null;
let clientUrl = null;

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    const error = new Error("DATABASE_URL mancante.");
    error.publicMessage = "Configurazione database incompleta.";
    error.statusCode = 500;
    throw error;
  }
  return value;
}

function db() {
  const url = databaseUrl();
  if (!client || clientUrl !== url) {
    client = neon(url);
    clientUrl = url;
  }
  return client;
}

async function query(text, params = []) {
  if (typeof globalThis.__quizPatenteDbQuery === "function") {
    return globalThis.__quizPatenteDbQuery(text, params);
  }
  return db().query(text, params);
}

module.exports = { query };
