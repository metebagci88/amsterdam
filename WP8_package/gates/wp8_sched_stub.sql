-- WP8 CI-ONLY doubles for pg_cron and pg_net (signatures as on Supabase). Never applied to production.
create schema if not exists cron;
create schema if not exists net;
create table if not exists cron.job (
  jobid bigserial primary key, schedule text not null, command text not null, nodename text default 'localhost',
  nodeport int default 5432, database text default current_database(), username text not null default current_user,
  active boolean not null default true, jobname text unique);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job(jobname, schedule, command, username) values (job_name, schedule, command, current_user)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, username = excluded.username
  returning jobid
$$;
create or replace function cron.unschedule(job_id bigint) returns boolean
language sql as $$ delete from cron.job where jobid = job_id returning true $$;
create table if not exists net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int);
create table if not exists net._http_response (id bigint, status_code int, created timestamptz not null default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000) returns bigint
language sql as $$
  insert into net.calls(url, headers, body, timeout_milliseconds) values (url, headers, body, timeout_milliseconds) returning id
$$;
