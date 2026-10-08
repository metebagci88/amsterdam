// ASALOCAL · CDP-3B · LOCAL TEST DOUBLE (docker-free) — never deployed, never pointed at production.
// Postgres for the local save-draft stack: PGlite 0.3.16 (= PostgreSQL 17, WASM, in-memory) behind
// @electric-sql/pglite-socket 0.0.22 on 127.0.0.1 only. Loads the REAL gates/baseline_fixture.sql + CDP3B_up.sql +
// CDP3B_patch_asset_preview_up.sql on top of minimal Supabase platform doubles (roles, auth.users, extensions.pgcrypto).
// Seeds synthetic test actors (random UUIDs) and random opaque bearer tokens in local_auth.tokens; writes them as
// KEY=value lines to <env-out> (mode 0600). Nothing is printed except "LOCAL_DB_READY <port>".
// Usage: node db_server.mjs <CDP3B dir> <port> <env-out>
// Fidelity limits: one PG session multiplexed for all clients (statements serialise; no true parallel race);
// the edge shim connects as superuser, so EXECUTE grants are NOT exercised here (CI covers them).
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const [, , CDP3B, PORT_S, ENV_OUT] = process.argv;
if (!CDP3B || !PORT_S || !ENV_OUT) { console.error("usage: node db_server.mjs <CDP3B dir> <port> <env-out>"); process.exit(2); }
const PORT = Number(PORT_S);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
  create schema if not exists auth; create table if not exists auth.users(id uuid primary key, email text unique);
  create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;
  create schema if not exists storage;
  create table if not exists storage.buckets(id text primary key, name text, public boolean);
  create table if not exists storage.objects(bucket_id text, name text);
  create schema if not exists local_auth;
  create table if not exists local_auth.tokens(token text primary key, uid uuid not null references auth.users(id));
`);
for (const f of ["gates/baseline_fixture.sql", "CDP3B_up.sql", "CDP3B_patch_asset_preview_up.sql"]) {
  await db.exec(readFileSync(join(CDP3B, f), "utf8"));
}

// synthetic actors: SUPER (super_admin), CRM (crm), ANALYST (analyst), MEMBER (GoTrue user, no admin_users row)
const ROLES = { SUPER: "super_admin", CRM: "crm", ANALYST: "analyst", MEMBER: null };
const env = [];
for (const [k, role] of Object.entries(ROLES)) {
  const uid = randomUUID();
  const tok = "local-" + k.toLowerCase() + "-" + randomBytes(24).toString("hex");
  const email = k.toLowerCase() + "_" + uid.slice(0, 8) + "@e2e.local";
  const pw = randomBytes(18).toString("base64url") + "Aa1!";
  await db.query("insert into auth.users(id,email) values ($1,$2)", [uid, email]);
  await db.query("insert into local_auth.tokens(token,uid) values ($1,$2)", [tok, uid]);
  if (role) {
    await db.query("insert into public.admin_users(user_id) values ($1)", [uid]);
    await db.query("insert into public.admin_roles(user_id,role) values ($1,$2::public.admin_role)", [uid, role]);
  }
  env.push(`${k}_JWT=${tok}`, `${k}_UID=${uid}`, `${k}_EMAIL=${email}`, `${k}_PW=${pw}`);
}
await db.query("insert into public.admin_settings(key,bool_value) values ('admin_writes_enabled', true) on conflict (key) do update set bool_value=excluded.bool_value");

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 32 });
await server.start();
// URL built at runtime with a random per-run password (the PGlite socket accepts any password; none is stored in source)
const dbUrl = new URL("postgres://127.0.0.1/postgres?sslmode=disable");
const pw = randomBytes(12).toString("hex");
Object.assign(dbUrl, { port: String(PORT), username: "postgres", password: pw });
env.push("SUPABASE_DB_URL=" + dbUrl.href);
writeFileSync(ENV_OUT, env.join("\n") + "\n", { mode: 0o600 });
console.log("LOCAL_DB_READY " + PORT);
const stop = async () => { try { await server.stop(); } catch { /* noop */ } try { await db.close(); } catch { /* noop */ } process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
