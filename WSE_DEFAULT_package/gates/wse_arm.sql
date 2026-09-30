-- CI/ephemeral ONLY. Aktivasyon dosyasından hemen önce, aynı transaction.
insert into public.admin_users(user_id, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true)
on conflict (user_id) do nothing;

insert into public.admin_roles(user_id, role)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'super_admin')
on conflict (user_id, role) do nothing;

select set_config('wse.allow_activation', 'YES', true);
select set_config('wse.actor', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('wse.reason', 'ephemeral welcome v1 activation', true);
select set_config('wse.request_id', 'wse-act-ephemeral', true);
select set_config('wse.idem', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
