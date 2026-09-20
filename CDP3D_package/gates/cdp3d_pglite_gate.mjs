// CDP-3D PGlite SQL gate — gerçek Postgres (WASM) üzerinde CDP3D_up.sql + fail-closed/
// suppression matrisi/0C idempotency/monoton durum/lease/bounce-sınıfı/PII/append-only/rollback.
// Concurrency (iki bağlantı) kanıtı gerçek ephemeral Supabase CI'da; burada tek-bağlantı mantığı.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";

const db = await new PGlite({ extensions: { pgcrypto } });
let pass=0, fail=0; const log=[];
const ok=(n,c)=>{ c?(pass++,log.push("PASS "+n)):(fail++,log.push("FAIL "+n)); };
async function q(sql,params){ return (await db.query(sql,params)).rows; }
async function expectErr(n, fn, frag){ try{ await fn(); fail++; log.push("FAIL "+n+" (no error)"); }catch(e){ (!frag||e.message.includes(frag))?(pass++,log.push("PASS "+n)):(fail++,log.push("FAIL "+n+" wrong err: "+e.message)); } }

try {
  await db.exec(readFileSync("gates/cdp3d_prereq_stub.sql","utf8"));
  await db.exec(readFileSync("CDP3D_up.sql","utf8"));
  log.push("-- migration loaded OK --");
  // idempotent second apply (aynı dosyayı tekrar) — additive/if-not-exists doğrulama
  await db.exec(readFileSync("CDP3D_up.sql","utf8"));
  log.push("-- second apply idempotent OK --");

  const U1="11111111-1111-1111-1111-111111111111", U2="22222222-2222-2222-2222-222222222222", U3="33333333-3333-3333-3333-333333333333";
  await db.exec(`insert into public.members(user_id,email) values ('${U1}','alice@example.com'),('${U2}','bob@example.com');`);
  const A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await db.exec(`insert into public.admin_users(user_id,active) values ('${A}',true); insert into public.admin_roles(user_id,role) values ('${A}','super_admin');`);

  const en = await q(`select unnest(enum_range(null::public.email_message_class))::text v`);
  ok("enum sadece 2 sınıf, marketing yok", en.length===2 && !en.some(r=>r.v==='marketing'));
  ok("from_email default send.asalocal.club", (await q(`select from_email from public.email_provider_config where id=1`))[0].from_email==='no-reply@send.asalocal.club');

  let r = await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U1]);
  ok("config kapalı -> class_disabled", r[0].d.skip_reason==='class_disabled');
  await db.exec(`update public.email_provider_config set essential_enabled=true, service_enabled=true where id=1;`);
  r = await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U1]);
  ok("allowlist yok -> not_in_allowlist", r[0].d.skip_reason==='not_in_allowlist');
  await db.exec(`insert into public.email_send_allowlist(user_id,active) values ('${U1}',true),('${U2}',true);`);
  r = await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U1]);
  ok("pref yok -> service_pref_missing (backfill yok)", r[0].d.skip_reason==='service_pref_missing');
  await db.exec(`insert into public.member_service_pref_current(user_id,pref_key,enabled) values ('${U1}','welcome_service_email',false);`);
  r = await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U1]);
  ok("pref false -> service_pref_disabled", r[0].d.skip_reason==='service_pref_disabled');
  await db.exec(`update public.member_service_pref_current set enabled=true where user_id='${U1}' and pref_key='welcome_service_email';`);
  r = await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U1]);
  ok("pref true -> allow", r[0].d.allow===true && /^[0-9a-f]{64}$/.test(r[0].d.recipient_hmac));
  r = await q(`select public._email_send_decision($1,'essential_transactional',null) d`,[U1]);
  ok("essential allow", r[0].d.allow===true);
  await db.exec(`insert into public.email_send_allowlist(user_id,active) values ('${U3}',true);`);
  r = await q(`select public._email_send_decision($1,'essential_transactional',null) d`,[U3]);
  ok("email yok -> recipient_missing_email", r[0].d.skip_reason==='recipient_missing_email');

  // suppression matrisi
  const h2 = (await q(`select public._contact_hmac('bob@example.com',1) h`))[0].h;
  const ev = (await q(`insert into public.contact_suppression_events(channel,scope,contact_hmac,reason,action,source,request_id,idempotency_key,fingerprint) values ('email','all_email',$1,'user_unsubscribe','suppress','unsubscribe','rid1',gen_random_uuid(),'fp1') returning id`,[h2]))[0].id;
  await db.exec(`insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,status,source_event_id) values ('email','${h2}','all_email','user_unsubscribe','active','${ev}');`);
  await db.exec(`insert into public.member_service_pref_current(user_id,pref_key,enabled) values ('${U2}','welcome_service_email',true);`);
  r = await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U2]);
  ok("unsubscribe all_email -> optional_service BLOCK", r[0].d.skip_reason==='suppressed_unsubscribe');
  r = await q(`select public._email_send_decision($1,'essential_transactional',null) d`,[U2]);
  ok("unsubscribe all_email -> essential ALLOW (matris)", r[0].d.allow===true);
  const h1 = (await q(`select public._contact_hmac('alice@example.com',1) h`))[0].h;
  const ev2 = (await q(`insert into public.contact_suppression_events(channel,scope,contact_hmac,reason,action,source,request_id,idempotency_key,fingerprint) values ('email','all_email',$1,'hard_bounce','suppress','system','rid2',gen_random_uuid(),'fp2') returning id`,[h1]))[0].id;
  await db.exec(`insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,status,source_event_id) values ('email','${h1}','all_email','hard_bounce','active','${ev2}');`);
  ok("hard_bounce -> optional_service BLOCK", (await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U1]))[0].d.skip_reason==='suppressed_hard_bounce');
  ok("hard_bounce -> essential BLOCK", (await q(`select public._email_send_decision($1,'essential_transactional',null) d`,[U1]))[0].d.skip_reason==='suppressed_hard_bounce');

  // enqueue + 0C idempotency
  const U4="44444444-4444-4444-4444-444444444444";
  await db.exec(`insert into public.members(user_id,email) values ('${U4}','carol@example.com'); insert into public.email_send_allowlist(user_id,active) values ('${U4}',true); insert into public.member_service_pref_current(user_id,pref_key,enabled) values ('${U4}','welcome_service_email',true);`);
  let enq = (await q(`select public.email_enqueue($1,'optional_service','welcome_service_email','Hoş geldin','<b>hi</b>','hi',null,'idem-1','rid-x') d`,[U4]))[0].d;
  ok("enqueue -> queued", enq.status==='queued');
  let enq2 = (await q(`select public.email_enqueue($1,'optional_service','welcome_service_email','Hoş geldin','<b>hi</b>','hi',null,'idem-1','rid-x') d`,[U4]))[0].d;
  ok("aynı key + aynı payload -> idempotent (aynı id)", enq2.idempotent===true && enq2.id===enq.id);
  await expectErr("aynı key + farklı payload -> idempotency_conflict", async()=>{ await q(`select public.email_enqueue($1,'optional_service','welcome_service_email','FARKLI konu','<b>hi</b>','hi',null,'idem-1','rid-x')`,[U4]); }, "idempotency_conflict");
  ok("outbox tek satır", (await q(`select count(*) c from public.email_outbox where idempotency_key='idem-1'`))[0].c==1);

  // claim + lease
  let cl = await q(`select * from public.email_claim_batch(10)`);
  const row = cl.find(x=>x.outbox_id===enq.id);
  ok("claim -> recipient_email çözüldü + send.asalocal.club", row && row.recipient_email==='carol@example.com' && row.from_email==='no-reply@send.asalocal.club');
  let rowdb=(await q(`select status,claimed_at,lease_expires_at from public.email_outbox where id='${enq.id}'`))[0];
  ok("claim -> sending + lease set", rowdb.status==='sending' && rowdb.lease_expires_at!==null);

  // lease reclaim: lease'i geçmişe al, tekrar claim -> reclaim edilip yeniden sending
  await db.exec(`update public.email_outbox set lease_expires_at=now()-interval '1 hour' where id='${enq.id}';`);
  let cl2 = await q(`select * from public.email_claim_batch(10)`);
  ok("lease dolunca reclaim + yeniden claim", cl2.some(x=>x.outbox_id===enq.id) && (await q(`select status from public.email_outbox where id='${enq.id}'`))[0].status==='sending');

  // mark ok -> sent (monoton)
  await q(`select public.email_mark_result($1,true,'resend-msg-123',null)`,[enq.id]);
  ok("mark ok -> sent", (await q(`select status from public.email_outbox where id='${enq.id}'`))[0].status==='sent');
  // mark tekrar (artık sending değil) -> ignored
  ok("mark tekrar -> ignored (monoton)", (await q(`select public.email_mark_result($1,true,'x',null) d`,[enq.id]))[0].d.ignored===true);

  // webhook delivered (6 arg) + monoton
  await q(`select public.email_ingest_provider_event('svix-1','email.delivered','resend-msg-123','carol@example.com',now(),null)`);
  ok("delivered -> status delivered", (await q(`select status from public.email_outbox where id='${enq.id}'`))[0].status==='delivered');
  // geç gelen email.sent delivered'ı geri düşürmez (monoton)
  await q(`select public.email_ingest_provider_event('svix-1b','email.sent','resend-msg-123','carol@example.com',now(),null)`);
  ok("geç 'sent' delivered'ı geri düşürmez (monoton)", (await q(`select status from public.email_outbox where id='${enq.id}'`))[0].status==='delivered');
  // svix dedupe (atomik)
  ok("svix dedupe (atomik ON CONFLICT)", (await q(`select public.email_ingest_provider_event('svix-1','email.delivered','resend-msg-123','carol@example.com',now(),null) d`))[0].d.duplicate===true);

  // permanent bounce -> suppression + failed
  const U5="55555555-5555-5555-5555-555555555555";
  await db.exec(`insert into public.members(user_id,email) values ('${U5}','dan@example.com'); insert into public.email_send_allowlist(user_id,active) values ('${U5}',true); insert into public.member_service_pref_current(user_id,pref_key,enabled) values ('${U5}','welcome_service_email',true);`);
  let e5=(await q(`select public.email_enqueue($1,'optional_service','welcome_service_email','x','<b>x</b>','x',null,'idem-5','r5') d`,[U5]))[0].d;
  await q(`select * from public.email_claim_batch(10)`);
  await q(`select public.email_mark_result($1,true,'msg-5',null)`,[e5.id]);
  await q(`select public.email_ingest_provider_event('svix-5','email.bounced','msg-5','dan@example.com',now(),'Permanent')`);
  ok("permanent bounce -> outbox failed", (await q(`select status from public.email_outbox where id='${e5.id}'`))[0].status==='failed');
  const h5=(await q(`select public._contact_hmac('dan@example.com',1) h`))[0].h;
  ok("permanent bounce -> hard_bounce suppression", (await q(`select count(*) c from public.contact_suppression_current where contact_hmac='${h5}' and reason='hard_bounce' and status='active'`))[0].c==1);
  ok("bounce sonrası send blocked", (await q(`select public._email_send_decision($1,'optional_service','welcome_service_email') d`,[U5]))[0].d.skip_reason==='suppressed_hard_bounce');

  // TRANSIENT bounce -> suppression YOK (düzeltme #6)
  const U6="66666666-6666-6666-6666-666666666666";
  await db.exec(`insert into public.members(user_id,email) values ('${U6}','eve@example.com'); insert into public.email_send_allowlist(user_id,active) values ('${U6}',true); insert into public.member_service_pref_current(user_id,pref_key,enabled) values ('${U6}','welcome_service_email',true);`);
  let e6=(await q(`select public.email_enqueue($1,'optional_service','welcome_service_email','y','<b>y</b>','y',null,'idem-6','r6') d`,[U6]))[0].d;
  await q(`select * from public.email_claim_batch(10)`);
  await q(`select public.email_mark_result($1,true,'msg-6',null)`,[e6.id]);
  await q(`select public.email_ingest_provider_event('svix-6','email.bounced','msg-6','eve@example.com',now(),'Transient')`);
  const h6=(await q(`select public._contact_hmac('eve@example.com',1) h`))[0].h;
  ok("transient bounce -> KALICI suppression YOK", (await q(`select count(*) c from public.contact_suppression_current where contact_hmac='${h6}' and status='active'`))[0].c==0);

  // delivery_delayed -> durum değişmez (transient)
  const U7="77777777-7777-7777-7777-777777777777";
  await db.exec(`insert into public.members(user_id,email) values ('${U7}','fay@example.com'); insert into public.email_send_allowlist(user_id,active) values ('${U7}',true); insert into public.member_service_pref_current(user_id,pref_key,enabled) values ('${U7}','welcome_service_email',true);`);
  let e7=(await q(`select public.email_enqueue($1,'optional_service','welcome_service_email','z','<b>z</b>','z',null,'idem-7','r7') d`,[U7]))[0].d;
  await q(`select * from public.email_claim_batch(10)`);
  await q(`select public.email_mark_result($1,true,'msg-7',null)`,[e7.id]);
  await q(`select public.email_ingest_provider_event('svix-7','email.delivery_delayed','msg-7','fay@example.com',now(),null)`);
  ok("delivery_delayed -> durum sent kalır (transient)", (await q(`select status from public.email_outbox where id='${e7.id}'`))[0].status==='sent');

  // sistem suppression user reason YASAK
  await expectErr("system suppression user_unsubscribe YASAK", async()=>{ await q(`select public._email_system_apply_suppression('x@y.com','user_unsubscribe','ref')`); }, "system_reason_not_allowed");

  // PII-min
  ok("outbox'ta ham e-posta yok", (await q(`select count(*) c from public.email_outbox where subject like '%@%' or coalesce(body_text,'') like '%@example.com%'`))[0].c==0);
  ok("outbox recipient_hmac 64-hex", (await q(`select count(*) c from public.email_outbox where recipient_hmac !~ '^[0-9a-f]{64}$'`))[0].c==0);
  ok("send_events PII yok", (await q(`select count(*) c from public.email_send_events where recipient_hmac is not null and recipient_hmac !~ '^[0-9a-f]{64}$'`))[0].c==0);

  // retention purge
  await db.exec(`update public.email_outbox set updated_at=now()-interval '60 days' where id='${e5.id}';`);
  let pg=(await q(`select public.email_purge_expired_content() d`))[0].d;
  ok("retention purge çalışır", pg.purged>=1 && (await q(`select subject,body_text,content_purged_at from public.email_outbox where id='${e5.id}'`))[0].subject==='[purged]');

  // append-only
  await expectErr("send_events UPDATE engellenir", async()=>{ await q(`update public.email_send_events set event_type='x'`); }, "append_only");
  await expectErr("send_events DELETE engellenir", async()=>{ await q(`delete from public.email_send_events`); }, "append_only");

  // admin okuma
  let st=(await q(`select public.admin_q_email_delivery_status($1) d`,[A]))[0].d;
  ok("admin status okuma çalışır", st.config && st.config.public_go_live===false);
  await expectErr("admin status non-admin forbidden", async()=>{ await q(`select public.admin_q_email_delivery_status($1)`,[U1]); }, "forbidden");
  ok("public_go_live kapalı (go-live kapısı kurulu, açık değil)", (await q(`select public_go_live from public.email_provider_config where id=1`))[0].public_go_live===false);

  // ACL: fonksiyonlar anon/authenticated'a kapalı
  ok("email_enqueue anon/authenticated'a REVOKE", (await q(`select count(*) c from information_schema.role_routine_grants where routine_name='email_enqueue' and grantee in ('anon','authenticated')`))[0].c==0);
  ok("email_claim_batch service_role'e GRANT", (await q(`select count(*) c from information_schema.role_routine_grants where routine_name='email_claim_batch' and grantee='service_role'`))[0].c>=1);

  // rollback
  await db.exec(readFileSync("CDP3D_down_soft.sql","utf8"));
  ok("rollback: email_outbox düştü", (await q(`select count(*) c from information_schema.tables where table_schema='public' and table_name='email_outbox'`))[0].c==0);
  ok("rollback: email_message_class enum düştü", (await q(`select count(*) c from pg_type where typname='email_message_class'`))[0].c==0);
  ok("rollback: _contact_hmac KORUNDU", (await q(`select count(*) c from pg_proc where proname='_contact_hmac'`))[0].c>=1);
  ok("rollback: contact_suppression_current KORUNDU", (await q(`select count(*) c from information_schema.tables where table_schema='public' and table_name='contact_suppression_current'`))[0].c==1);
  ok("rollback: suppression verisi KORUNDU", (await q(`select count(*) c from public.contact_suppression_current`))[0].c>=1);

} catch(e){ fail++; log.push("FATAL "+e.message+"\n"+(e.stack||"")); }

console.log(log.join("\n"));
console.log(`\nRESULT pass=${pass} fail=${fail}`);
console.log(fail===0 ? "CDP3D_LOCAL_GATES_PASS" : "CDP3D_LOCAL_GATES_FAIL");
process.exit(fail===0?0:1);
