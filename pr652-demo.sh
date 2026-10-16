#!/bin/zsh
# usage: demo.sh <api-port> <label>   (NOPAUSE=1 to skip pauses)
PORT=$1; LABEL=$2
API=http://localhost:$PORT
set -a; source /Users/amalanandmuthukumaran/dev/mike-wt/word-org-workspaces/backend/.env; set +a
PORT=$1; API=http://localhost:$PORT
export PGPASSWORD=postgres
sql() { printf '\033[2m%s\033[0m\n' "$1"; psql -h 127.0.0.1 -p 55322 -U postgres -d postgres -tA -F ' | ' -c "$1" 2>&1 | sed 's/^/  -> /'; }
pause() { [[ -n "$NOPAUSE" ]] || sleep ${1:-2.5}; }
say() { printf '\n\033[1;36m# %s\033[0m\n' "$*"; }
show() { printf '\033[2m$ %s\033[0m\n' "$*"; }
jqs2() { python3 -I -c "import sys,json
raw=sys.stdin.read(); body,_,code=raw.rpartition(' [HTTP ')
try:
    d=json.loads(body); print('content:', repr((d.get('content') or '')[:200]) if 'content' in d else d, '[HTTP '+code.strip())
except Exception: print(raw[:300])"; }
jqs() { python3 -I -c "import sys,json
d=json.load(sys.stdin)
$1"; }
token() { curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "Content-Type: application/json" -d "{\"email\":\"$1\",\"password\":\"MikeWord-dev1\"}" | jqs 'print(d["access_token"])'; }
printf '\033[1;33m== %s  (backend on :%s)\033[0m\n' "$LABEL" "$PORT"
TA=$(token mamalanand3@gmail.com); TB=$(token colleague@example.com)
HA=(-H "Authorization: Bearer $TA" -H "Content-Type: application/json")
HB=(-H "Authorization: Bearer $TB" -H "Content-Type: application/json")
BID=$(printf '%s' "$TB" | cut -d. -f2 | python3 -I -c 'import sys,base64,json;t=sys.stdin.read();print(json.loads(base64.urlsafe_b64decode(t+"="*(-len(t)%4)))["sub"])')
DOC=$(uuidgen | tr A-Z a-z)

say "Admin creates the team organization and invites a colleague"
ORG=$(curl -s -X POST "$API/orgs" "${HA[@]}" -d '{"name":"Acme Legal '$LABEL'"}' | jqs 'print(d["id"])')
echo "org_id=$ORG"
curl -s -X POST "$API/orgs/$ORG/invitations" "${HA[@]}" -d '{"email":"colleague@example.com","role":"member"}' > /dev/null
INV=$(curl -s "$API/user/invitations" "${HB[@]}" | jqs 'print([i for i in d if i["org_id"]=="'$ORG'"][0]["id"])')
curl -s -X POST "$API/user/invitations/$INV/accept" "${HB[@]}" | jqs 'print("colleague joined as", d.get("role") or d)'
pause

say "0. Colleague switches on memory for Personal and for the organization's workspace"
curl -s -X PATCH "$API/user/memory/settings" "${HB[@]}" -d '{"enabled":true}' | jqs 'print("personal memory:", d.get("enabled", d))'
curl -s -X PATCH "$API/user/memory/settings?workspace=$ORG" "${HB[@]}" -d '{"enabled":true}' | jqs 'print("organization memory:", d.get("enabled", d))'
pause

say "1. Colleague starts a Word chat in the organization's workspace (org_id in the body)"
show "POST /word-chat {document_id, storage:cloud, org_id, messages}"
curl -sN -X POST "$API/word-chat" "${HB[@]}" -d '{"document_id":"'$DOC'","storage":"cloud","model":"gpt-5.4-mini","org_id":"'$ORG'","messages":[{"role":"user","content":"Remember this working convention for all my drafting: write clause cross-references as clause 4.2, never Section 4.2, and put defined terms in bold. Reply in one short sentence."}]}' > /tmp/wc-$LABEL.sse
head -c 600 /tmp/wc-$LABEL.sse | grep -E '^data:' | head -4 | cut -c1-160
CHAT=$(grep -o '"chatId":"[^"]*"' /tmp/wc-$LABEL.sse | head -1 | cut -d'"' -f4)
echo "chat_id=$CHAT"
pause

say "2. The document's chats, per workspace"
show "GET /word-chat?document_id=\$DOC&workspace=\$ORG"
curl -s "$API/word-chat?document_id=$DOC&workspace=$ORG" "${HB[@]}" | jqs 'rows=d if isinstance(d,list) else d.get("chats",d); print([{"id":r["id"][:8]+"…","org_id":(r["org_id"][:8]+"…" if r.get("org_id") else r.get("org_id","<field absent>"))} for r in rows])'
show "GET /word-chat?document_id=\$DOC&workspace=personal"
curl -s "$API/word-chat?document_id=$DOC&workspace=personal" "${HB[@]}" | jqs 'rows=d if isinstance(d,list) else d.get("chats",d); print([{"id":r["id"][:8]+"…","org_id":(r["org_id"][:8]+"…" if r.get("org_id") else r.get("org_id","<field absent>"))} for r in rows])'
pause

say "3. An organization Word chat saved only on the device"
show "POST /word-chat {storage:local, org_id}"
curl -s -o /tmp/wc-local-$LABEL.out -w 'HTTP %{http_code}\n' -X POST "$API/word-chat" "${HB[@]}" -d '{"document_id":"'$DOC'","storage":"local","model":"gpt-5.4-mini","org_id":"'$ORG'","messages":[{"role":"user","content":"hi"}]}'
head -c 300 /tmp/wc-local-$LABEL.out | grep -v '^data: {"type":"text' | head -3 | cut -c1-160; echo
pause

say "4. Quick actions on the Word surface, in the organization"
WF=$(curl -s -X POST "$API/workflows" "${HB[@]}" -d '{"metadata":{"title":"Firm NDA checklist '$LABEL'","type":"assistant"},"skill_md":"Check the NDA against firm policy.","org_id":"'$ORG'"}' | jqs 'print(d.get("id") or d)')
curl -s -X POST "$API/quick-actions" "${HB[@]}" -d '{"workflow_id":"'$WF'","name":"NDA check","prompt":"Run the firm NDA checklist","surface":"word"}' | jqs 'print("quick action ->", d.get("name") or d)'
show "GET /quick-actions?surface=word&workspace=\$ORG"
curl -s "$API/quick-actions?surface=word&workspace=$ORG" "${HB[@]}" | jqs 'print([a["name"] for a in d] if isinstance(d,list) else d)'
show "GET /quick-actions?surface=word&workspace=personal"
curl -s "$API/quick-actions?surface=word&workspace=personal" "${HB[@]}" | jqs 'print([a["name"] for a in d] if isinstance(d,list) else d)'
pause

say "5. What the memory curator learned from that Word chat (after the inactivity window)"
printf 'waiting for the curator (inactivity window 5s + one curator model call) '
for i in {1..40}; do
  if [[ "$LABEL" == main ]]; then c=$(curl -s "$API/user/memory" "${HB[@]}" | jqs 'print(d.get("content") or "")'); else c=$(curl -s "$API/user/memory?workspace=$ORG" "${HB[@]}" | jqs 'print(d.get("content") or "")'); fi
  [[ -n "$c" ]] && break
  printf '.'; sleep 3
done; echo
show "GET /user/memory?workspace=\$ORG   (organization memory)"
curl -s -w ' [HTTP %{http_code}]\n' "$API/user/memory?workspace=$ORG" "${HB[@]}" | jqs2
show "GET /user/memory                    (Personal memory)"
curl -s -w ' [HTTP %{http_code}]\n' "$API/user/memory" "${HB[@]}" | jqs2
pause
say "5b. Postgres: where does this Word chat's memory belong, and may its author learn into it?"
sql "select column_name from information_schema.columns where table_name='word_chats' and column_name='org_id'"
sql "select memory_source_org_id('word', '$CHAT'::uuid) as memory_workspace"
sql "select memory_source_allows_app_memory('word', '$CHAT'::uuid, '$BID'::uuid, null) as author_may_learn"
pause

say "6. Admin removes the colleague from the organization"
show "DELETE /orgs/\$ORG/members/\$COLLEAGUE  (as admin)"
curl -s -o /tmp/rm-$LABEL.out -w 'HTTP %{http_code} ' -X DELETE "$API/orgs/$ORG/members/$BID" "${HA[@]}"; head -c 200 /tmp/rm-$LABEL.out; echo
show "GET /word-chat/\$CHAT?document_id=\$DOC  (as the removed colleague)"
curl -s -o /tmp/wc-detail-$LABEL.out -w 'HTTP %{http_code}  ' "$API/word-chat/$CHAT?document_id=$DOC" "${HB[@]}"; head -c 120 /tmp/wc-detail-$LABEL.out; echo
show "GET /word-chat?document_id=\$DOC  (no workspace filter)"
curl -s "$API/word-chat?document_id=$DOC" "${HB[@]}" | jqs 'rows=d if isinstance(d,list) else d.get("chats",d); print(len(rows),"chat(s) listed")'
pause
[[ -n "$SKIP_PURGE" ]] && { echo "export ORG=$ORG CHAT=$CHAT DOC=$DOC BID=$BID" > /tmp/demo-$LABEL.vars; exit 0; }
say "7. Postgres: after the departure, and when the organization is purged"
sql "select memory_source_allows_app_memory('word', '$CHAT'::uuid, '$BID'::uuid, null) as author_may_learn"
sql "update organizations set deleted_at=now()-interval '1 minute', purge_after=now() where id='$ORG'"
sql "select purge_expired_organizations()"
sql "select count(*) as org_rows_left from organizations where id='$ORG'"
sql "select count(*) as word_chat_rows_left from word_chats where id='$CHAT'"
pause
printf '\n\033[1;33m== %s DEMO DONE\033[0m\n' "$LABEL"
echo "export ORG=$ORG CHAT=$CHAT DOC=$DOC BID=$BID" > /tmp/demo-$LABEL.vars
