create extension if not exists pgcrypto;

create table if not exists public.robot_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '与 Home Robot 的对话',
  relationship_stage text not null default 'established_partner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint robot_conversations_title_length check (char_length(title) between 1 and 120)
);

create table if not exists public.robot_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.robot_conversations (id) on delete cascade,
  client_message_id text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  parts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);

create index if not exists robot_conversations_user_updated_idx
  on public.robot_conversations (user_id, updated_at desc);

create index if not exists robot_messages_conversation_created_idx
  on public.robot_messages (conversation_id, created_at asc);

create or replace function public.robot_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists robot_conversations_set_updated_at on public.robot_conversations;
create trigger robot_conversations_set_updated_at
before update on public.robot_conversations
for each row execute function public.robot_set_updated_at();

create or replace function public.robot_touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.robot_conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists robot_messages_touch_conversation on public.robot_messages;
create trigger robot_messages_touch_conversation
after insert or update on public.robot_messages
for each row execute function public.robot_touch_conversation();

-- 触发器内部函数不对 API 客户端开放，降低被 RPC 直接调用的风险。
revoke execute on function public.robot_set_updated_at() from public, anon, authenticated;
revoke execute on function public.robot_touch_conversation() from public, anon, authenticated;

alter table public.robot_conversations enable row level security;
alter table public.robot_messages enable row level security;

revoke all on public.robot_conversations from anon;
revoke all on public.robot_messages from anon;
grant select, insert, update, delete on public.robot_conversations to authenticated;
grant select, insert, update, delete on public.robot_messages to authenticated;

drop policy if exists "robot users read own conversations" on public.robot_conversations;
create policy "robot users read own conversations"
on public.robot_conversations for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "robot users create own conversations" on public.robot_conversations;
create policy "robot users create own conversations"
on public.robot_conversations for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "robot users update own conversations" on public.robot_conversations;
create policy "robot users update own conversations"
on public.robot_conversations for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "robot users delete own conversations" on public.robot_conversations;
create policy "robot users delete own conversations"
on public.robot_conversations for delete
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "robot users read own messages" on public.robot_messages;
create policy "robot users read own messages"
on public.robot_messages for select
to authenticated
using (
  exists (
    select 1
    from public.robot_conversations conversation
    where conversation.id = conversation_id
      and conversation.user_id = (select auth.uid())
  )
);

drop policy if exists "robot users create own messages" on public.robot_messages;
create policy "robot users create own messages"
on public.robot_messages for insert
to authenticated
with check (
  exists (
    select 1
    from public.robot_conversations conversation
    where conversation.id = conversation_id
      and conversation.user_id = (select auth.uid())
  )
);

drop policy if exists "robot users update own messages" on public.robot_messages;
create policy "robot users update own messages"
on public.robot_messages for update
to authenticated
using (
  exists (
    select 1
    from public.robot_conversations conversation
    where conversation.id = conversation_id
      and conversation.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.robot_conversations conversation
    where conversation.id = conversation_id
      and conversation.user_id = (select auth.uid())
  )
);

drop policy if exists "robot users delete own messages" on public.robot_messages;
create policy "robot users delete own messages"
on public.robot_messages for delete
to authenticated
using (
  exists (
    select 1
    from public.robot_conversations conversation
    where conversation.id = conversation_id
      and conversation.user_id = (select auth.uid())
  )
);
