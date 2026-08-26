-- Migration date: 2026-08-26
-- Highlight-assigned chat agents.
--
-- An "agent" is a real chat row parented to the chat whose assistant response
-- the user highlighted. Modelling it as a chat (rather than a bespoke table)
-- means the agent's thread gets the whole existing chat stack for free —
-- streaming, message persistence, access control, deletion cascade.
--
-- Four additive columns on `chats` carry the assignment:
--   parent_chat_id    the chat this agent was spawned from (null = ordinary
--                     chat). Depth is capped at one level in the API layer.
--   agent_instruction what the user asked this agent to do.
--   source_message_id the parent assistant message the excerpt came from.
--                     Deliberately not a foreign key: it is an anchor for
--                     rendering, and the parent-chat cascade below already
--                     removes agents when their conversation goes away.
--   source_excerpt    the highlighted text, stored so the dock and the
--                     proposal markers survive a reload.
--
-- `chat_messages.edited_at` records that an assistant message was rewritten by
-- an accepted agent proposal, so the UI can show a "revised" marker.

alter table public.chats
  add column if not exists parent_chat_id uuid
    references public.chats(id) on delete cascade,
  add column if not exists agent_instruction text,
  add column if not exists source_message_id uuid,
  add column if not exists source_excerpt text;

-- Partial: every lookup is "the agents of this parent", and ordinary chats
-- (the overwhelming majority of rows) never match.
create index if not exists idx_chats_parent
  on public.chats(parent_chat_id)
  where parent_chat_id is not null;

alter table public.chat_messages
  add column if not exists edited_at timestamptz;

-- Agents are reached from their parent conversation, never from the global
-- recent-chats list, so the overview RPC now filters them out. Same signature
-- and same grants as before; `create or replace` keeps both.
create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz,
  project_name text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.created_at,
    p.name as project_name
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.parent_chat_id is null
    and (
      c.user_id::text = p_user_id
      or (
        p.id is not null
        and p.user_id::text = p_user_id
      )
    )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;
