-- Several days for a recurring task (SPEC decision 131): a monthly one on any days of the
-- month (and the last day too, if wanted), a yearly one on any dates of the year. The one
-- day it had before becomes the first of its list.
alter table app.office_task_series
  add column month_days int[] not null default '{}' check (month_days <@ array[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]),
  add column year_dates text[] not null default '{}';   -- 'MM-DD'

update app.office_task_series set month_days = array[month_day] where frequency = 'monthly' and month_day is not null;
update app.office_task_series set year_dates = array[lpad(year_month::text, 2, '0') || '-' || lpad(month_day::text, 2, '0')]
where frequency = 'yearly' and year_month is not null and month_day is not null;

-- The single-day columns and the checks on them go.
alter table app.office_task_series drop column month_day, drop column year_month;

create function app.year_dates_ok(a text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(x ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'), true) from unnest(a) x
$$;
alter table app.office_task_series
  add constraint year_dates_valid check (app.year_dates_ok(year_dates)),
  add constraint monthly_has_days check (frequency <> 'monthly' or last_day or cardinality(month_days) > 0),
  add constraint yearly_has_dates check (frequency <> 'yearly' or cardinality(year_dates) > 0);

-- A day a month lacks (31 in a short month, 29 February) is the month's last day.
create or replace function app.series_on(s app.office_task_series, d date) returns boolean
language sql immutable set search_path = '' as $$
  with m as (select extract(day from date_trunc('month', d) + interval '1 month - 1 day')::int as last,
                    extract(day from d)::int as dom, extract(month from d)::int as mon)
  select case s.frequency
    when 'daily' then not s.workdays_only or extract(dow from d) between 0 and 4
    when 'weekly' then extract(dow from d) = s.weekday
    when 'monthly' then (s.last_day and m.dom = m.last)
      or exists (select 1 from unnest(s.month_days) x where least(x, m.last) = m.dom)
    when 'yearly' then exists (select 1 from unnest(s.year_dates) x
      where split_part(x, '-', 1)::int = m.mon and least(split_part(x, '-', 2)::int, m.last) = m.dom)
  end
  from m
$$;
