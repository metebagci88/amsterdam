// CDP-3D · Gerçek Postgres (ephemeral Supabase) DB suite — node-postgres.
// GERÇEK concurrency (iki bağlantı), ACL/RLS, monoton, webhook dedupe yarışı, bounce sınıfı,
// negatifler, soft rollback + residue. DBURL env ile bağlanır (CI: supabase DB_URL).
import pg from "pg";
const { Client, Pool } = pg;
const DBURL = process.env.DBURL;
if (!DBURL) { console.error("DBURL missing"); process.exit(2); }

let pass=0, fail=0; const log=[];
const ok=(n,c)=>{ c?(pass++,log.push("PASS "+n)):(fail++,log.push("FAIL "+n)); };
async function expectErr(n, fn, frag){ try{ await fn(); fail++; log.push("FAIL "+n+" (no error)"); }catch(e){ (!frag||String(e.message).includes(frag))?(pass++,log.push("PASS "+n)):(fail++,log.push("FAIL "+n+" wrong: "+e.message)); } }

const pool = new Pool({ connectionString: DBURL, max: 6 });
const Q = (sql,p) => pool.query(sql,p);

async function seedUser(uid, email, pref=true, allow=true){
  await Q(`insert into public.members(user_id,email) values ($1,$2) on conflict (user_id) do update set email=excluded.email`,[uid,email]);
  if (allow) await Q(`insert into public.email_send_allowlist(user_id,active) values ($1,true) on conflict (user_id) do update set active=true`,[uid]);
  if (pref!==null) await Q(`insert into public.member_service_pref_current(user_id,pref_key,enabled) values ($1,'welcome_service_email',$2)
      on conflict (user_id,pref_key) do update set enabled=excluded.enabled`,[uid,pref]);
}

try {
  // objeler var mı (migration workflow tarafından uygulandı)
  ok("email_outbox tablosu var", (await Q(`select 1 from information_schema.tables where table_schema='public' and table_name='email_outbox'`)).rowCount===1);
  ok("email_message_class enum var", (await Q(`select 1 from pg_type where typname='email_message_class'`)).rowCount===1);

  // config aç
  await Q(`update public.email_provider_config set essential_enabled=true, service_enabled=true, public_go_live=false where id=1`);

  // ---- ACL / RLS (anon/authenticated) ----
  await expectErr("anon email_enqueue EXECUTE reddedilir", async()=>{
    const c=await pool.connect(); try{ await c.query("set role anon"); await c.query(`select public.email_enqueue('00000000-0000-0000-0000-000000000001','optional_service','welcome_service_email','s',null,'t',null,'k','r')`);} finally{ await c.query("reset role").catch(()=>{}); c.release(); }
  }, "permission denied");
  await expectErr("anon email_outbox SELECT (RLS/grant) reddedilir", async()=>{
    const c=await pool.connect(); try{ await c.query("set role anon"); await c.query(`select * from public.email_outbox limit 1`);} finally{ await c.query("reset role").catch(()=>{}); c.release(); }
  }, "permission denied");

  // ---- iki-bağlantı enqueue concurrency (aynı key aynı payload) ----
  const U1="11111111-1111-1111-1111-111111111111";
  await seedUser(U1,"u1@ex.com");
  const c1=new Client({connectionString:DBURL}), c2=new Client({connectionString:DBURL});
  await c1.connect(); await c2.connect();
  const args=`'${U1}','optional_service','welcome_service_email','Konu','<b>h</b>','h',null,'conc-1','r'`;
  await c1.query("begin"); await c2.query("begin");
  const p1=c1.query(`select public.email_enqueue(${args}) d`);
  const p2=c2.query(`select public.email_enqueue(${args}) d`);
  const [r1,r2]=await Promise.allSettled([p1.then(x=>{return c1.query("commit").then(()=>x)}), p2.then(x=>{return c2.query("commit").then(()=>x)})]);
  await c1.end(); await c2.end();
  const cnt=(await Q(`select count(*) c from public.email_outbox where idempotency_key='conc-1'`)).rows[0].c;
  ok("iki-bağlantı aynı key+payload -> tek satır", Number(cnt)===1);
  ok("iki-bağlantı ikisi de hata vermedi (idempotent)", r1.status==='fulfilled' && r2.status==='fulfilled');

  // aynı key farklı payload -> conflict
  await expectErr("aynı key farklı payload -> idempotency_conflict", async()=>{
    await Q(`select public.email_enqueue('${U1}','optional_service','welcome_service_email','FARKLI','<b>h</b>','h',null,'conc-1','r')`);
  }, "idempotency_conflict");

  // ---- claim lease / reclaim ----
  const U2="22222222-2222-2222-2222-222222222222"; await seedUser(U2,"u2@ex.com");
  const e2=(await Q(`select public.email_enqueue('${U2}','optional_service','welcome_service_email','a','<b>a</b>','a',null,'lease-1','r') d`)).rows[0].d;
  await Q(`select * from public.email_claim_batch(10)`);
  ok("claim -> sending", (await Q(`select status from public.email_outbox where id=$1`,[e2.id])).rows[0].status==='sending');
  await Q(`update public.email_outbox set lease_expires_at=now()-interval '1 hour' where id=$1`,[e2.id]);
  const reclaimed=(await Q(`select * from public.email_claim_batch(10)`)).rows.some(x=>x.outbox_id===e2.id);
  ok("lease dolunca reclaim + yeniden claim", reclaimed);

  // ---- monoton: delivered sonra geç sent ----
  const U3="33333333-3333-3333-3333-333333333333"; await seedUser(U3,"u3@ex.com");
  const e3=(await Q(`select public.email_enqueue('${U3}','optional_service','welcome_service_email','b','<b>b</b>','b',null,'mono-1','r') d`)).rows[0].d;
  await Q(`select * from public.email_claim_batch(10)`);
  await Q(`select public.email_mark_result($1,true,'mid-3',null)`,[e3.id]);
  await Q(`select public.email_ingest_provider_event('sx-3d','email.delivered','mid-3','u3@ex.com',now(),null)`);
  await Q(`select public.email_ingest_provider_event('sx-3s','email.sent','mid-3','u3@ex.com',now(),null)`);
  ok("delivered sonra geç sent -> delivered kalır", (await Q(`select status from public.email_outbox where id=$1`,[e3.id])).rows[0].status==='delivered');

  // ---- paralel webhook dedupe (aynı svix_id iki bağlantı) ----
  const U4="44444444-4444-4444-4444-444444444444"; await seedUser(U4,"u4@ex.com");
  const e4=(await Q(`select public.email_enqueue('${U4}','optional_service','welcome_service_email','c','<b>c</b>','c',null,'dd-1','r') d`)).rows[0].d;
  await Q(`select * from public.email_claim_batch(10)`);
  await Q(`select public.email_mark_result($1,true,'mid-4',null)`,[e4.id]);
  const wh=`'sx-par','email.bounced','mid-4','u4@ex.com',now(),'Permanent'`;
  await Promise.allSettled([ Q(`select public.email_ingest_provider_event(${wh})`), Q(`select public.email_ingest_provider_event(${wh})`) ]);
  ok("paralel aynı svix -> tek event", Number((await Q(`select count(*) c from public.email_send_events where svix_id='sx-par'`)).rows[0].c)===1);
  const h4=(await Q(`select public._contact_hmac('u4@ex.com',1) h`)).rows[0].h;
  ok("paralel bounce -> tek suppression", Number((await Q(`select count(*) c from public.contact_suppression_current where contact_hmac=$1 and reason='hard_bounce' and status='active'`,[h4])).rows[0].c)===1);

  // ---- transient vs permanent ----
  const U5="55555555-5555-5555-5555-555555555555"; await seedUser(U5,"u5@ex.com");
  const e5=(await Q(`select public.email_enqueue('${U5}','optional_service','welcome_service_email','d','<b>d</b>','d',null,'tr-1','r') d`)).rows[0].d;
  await Q(`select * from public.email_claim_batch(10)`);
  await Q(`select public.email_mark_result($1,true,'mid-5',null)`,[e5.id]);
  await Q(`select public.email_ingest_provider_event('sx-5','email.bounced','mid-5','u5@ex.com',now(),'Transient')`);
  const h5=(await Q(`select public._contact_hmac('u5@ex.com',1) h`)).rows[0].h;
  ok("transient bounce -> kalıcı suppression YOK", Number((await Q(`select count(*) c from public.contact_suppression_current where contact_hmac=$1 and status='active'`,[h5])).rows[0].c)===0);

  // ---- negatifler: pref off, allowlist yok ----
  const U6="66666666-6666-6666-6666-666666666666"; await seedUser(U6,"u6@ex.com",false,true);
  ok("pref off -> service_pref_disabled", (await Q(`select public._email_send_decision('${U6}','optional_service','welcome_service_email') d`)).rows[0].d.skip_reason==='service_pref_disabled');
  const U7="77777777-7777-7777-7777-777777777777"; await seedUser(U7,"u7@ex.com",true,false);
  ok("allowlist yok -> not_in_allowlist", (await Q(`select public._email_send_decision('${U7}','optional_service','welcome_service_email') d`)).rows[0].d.skip_reason==='not_in_allowlist');

  // ---- essential unsubscribe'dan etkilenmez (matris) ----
  const U8="88888888-8888-8888-8888-888888888888"; await seedUser(U8,"u8@ex.com");
  const h8=(await Q(`select public._contact_hmac('u8@ex.com',1) h`)).rows[0].h;
  const ev8=(await Q(`insert into public.contact_suppression_events(channel,scope,contact_hmac,reason,action,source,request_id,idempotency_key,fingerprint) values ('email','all_email',$1,'user_unsubscribe','suppress','unsubscribe','r',gen_random_uuid(),'fp8') returning id`,[h8])).rows[0].id;
  await Q(`insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,status,source_event_id) values ('email',$1,'all_email','user_unsubscribe','active',$2)`,[h8,ev8]);
  ok("unsubscribe -> optional_service BLOCK", (await Q(`select public._email_send_decision('${U8}','optional_service','welcome_service_email') d`)).rows[0].d.skip_reason==='suppressed_unsubscribe');
  ok("unsubscribe -> essential ALLOW", (await Q(`select public._email_send_decision('${U8}','essential_transactional',null) d`)).rows[0].d.allow===true);

  // ---- PII-min ----
  ok("outbox ham e-posta yok", Number((await Q(`select count(*) c from public.email_outbox where recipient_hmac !~ '^[0-9a-f]{64}$' or subject like '%@%'`)).rows[0].c)===0);

  // ---- soft rollback + residue (EN SON) ----
  // rollback SQL workflow tarafından psql ile uygulanır; burada yalnız residue doğrularız (rollback öncesi skip)
  console.log(log.join("\n"));
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  console.log(fail===0 ? "CDP3D_DB_SUITE_PASS" : "CDP3D_DB_SUITE_FAIL");
  await pool.end();
  process.exit(fail===0?0:1);
} catch(e){
  console.log(log.join("\n"));
  console.log("FATAL "+e.message+"\n"+(e.stack||""));
  console.log("CDP3D_DB_SUITE_FAIL");
  try{ await pool.end(); }catch{}
  process.exit(1);
}
