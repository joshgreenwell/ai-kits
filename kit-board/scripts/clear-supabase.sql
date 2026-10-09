-- Empties the personal_hub tables on the retired Supabase database, keeping the schema and migration history.
--
-- Paste it into the Supabase dashboard's SQL editor, which runs as `postgres`, and run it once. See
-- docs/aurora-cutover.md, "Clearing Supabase". It refuses to run anywhere else, and it refuses to
-- delete anything if Supabase has changed since the October 2 comparison: every one of the
-- 739,214 rows it held was then found in Aurora, identical or superseded by a newer version.
-- Everything runs in one transaction, so a refusal deletes nothing.
begin;

do $guard$
declare
  total bigint := 0;
  n bigint;
  latest timestamptz;
  r record;
begin
  if current_database() <> 'postgres' or not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'This is not the Supabase database; nothing was deleted.';
  end if;

  for r in select c.oid::regclass as tbl from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'personal_hub' and c.relkind = 'r' loop
    execute format('select count(*) from %s', r.tbl) into n;
    total := total + n;
  end loop;
  if total <> 739214 then
    raise exception 'Supabase holds % rows, not the 739,214 compared on October 2. Re-run the comparison; nothing was deleted.', total;
  end if;

  for r in select format('%I.%I', a.table_schema, a.table_name) as tbl, a.column_name as col
           from information_schema.columns a join information_schema.tables t using (table_schema, table_name)
           where a.table_schema = 'personal_hub' and t.table_type = 'BASE TABLE' and a.data_type like 'timestamp%'
             and a.column_name in ('received_at', 'updated_at', 'last_seen_at', 'created_at', 'changed_at', 'last_reported_at',
                                   'last_config_fetch_at', 'inv_received_at', 'res_received_at', 'checked_at', 'used_at') loop
    execute format('select max(%I) from %s', r.col, r.tbl) into latest;
    if latest > '2026-09-30 03:48:00+00' then
      raise exception '%.% was written at %, after the cutover. Re-run the comparison; nothing was deleted.', r.tbl, r.col, latest;
    end if;
  end loop;
end
$guard$;

do $clear$
begin
  execute (select 'truncate table ' || string_agg(c.oid::regclass::text, ', ')
           from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'personal_hub' and c.relkind in ('r', 'p'));
end
$clear$;

commit;

-- The SQL editor shows the last result only: every personal_hub table, and 0 rows left in them.
select count(*) as personal_hub_tables,
       sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s', c.oid::regclass), false, true, '')))[1]::text::bigint) as rows_left
from pg_class c join pg_namespace s on s.oid = c.relnamespace
where s.nspname = 'personal_hub' and c.relkind = 'r';
