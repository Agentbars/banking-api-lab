#!/usr/bin/env bash
# End-to-end smoke against https://banking.srv1505121.hstgr.cloud.
# Uses fresh users each run (timestamp in email) so the daily-limit
# counter never overlaps between runs.
set -u

API="${API:-https://banking.srv1505121.hstgr.cloud}"
STAMP="$(date +%s)"
A_EMAIL="alice+${STAMP}@bank.io"
B_EMAIL="bob+${STAMP}@bank.io"
C_EMAIL="carol+${STAMP}@bank.io"

PASS=0
FAIL=0

assert() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS+1))
    printf '  \033[32mPASS\033[0m %-50s expected=%s\n' "$label" "$expected"
  else
    FAIL=$((FAIL+1))
    printf '  \033[31mFAIL\033[0m %-50s expected=%s got=%s\n' "$label" "$expected" "$actual"
  fi
}

http() {
  # http METHOD URL [TOKEN] [BODY] -> writes body to $BODY, sets $CODE
  local method="$1" url="$2" token="${3:-}" body="${4:-}"
  local hdr=()
  [ -n "$token" ] && hdr+=(-H "authorization: Bearer $token")
  if [ -n "$body" ]; then
    hdr+=(-H 'content-type: application/json')
    CODE=$(curl -sS -o /tmp/banking_body -w '%{http_code}' -X "$method" "${hdr[@]}" -d "$body" "$url")
  else
    CODE=$(curl -sS -o /tmp/banking_body -w '%{http_code}' -X "$method" "${hdr[@]}" "$url")
  fi
  BODY=$(cat /tmp/banking_body)
}

jq_get() {  # extract a top-level JSON field
  python3 -c "import sys,json; print(json.loads(sys.argv[1])['$2'])" "$1"
}

section() { printf '\n\033[34m=== %s ===\033[0m\n' "$1"; }

# ------------- §4.1 Auth -------------
section "Auth"

http POST "$API/auth/register" "" "{\"email\":\"$A_EMAIL\",\"name\":\"Alice\",\"password\":\"pass1234\"}"
assert "register Alice" 201 "$CODE"
http POST "$API/auth/register" "" "{\"email\":\"$B_EMAIL\",\"name\":\"Bob\",\"password\":\"pass1234\"}"
assert "register Bob" 201 "$CODE"
http POST "$API/auth/register" "" "{\"email\":\"$C_EMAIL\",\"name\":\"Carol\",\"password\":\"pass1234\"}"
assert "register Carol" 201 "$CODE"

http POST "$API/auth/register" "" "{\"email\":\"$A_EMAIL\",\"name\":\"X\",\"password\":\"pass1234\"}"
assert "register duplicate email" 409 "$CODE"

http POST "$API/auth/register" "" "{\"email\":\"bad\",\"name\":\"X\",\"password\":\"pass1234\"}"
assert "register bad email" 400 "$CODE"

http POST "$API/auth/register" "" "{\"email\":\"new+x@bank.io\",\"name\":\"X\",\"password\":\"7chars7\"}"
assert "register short password" 400 "$CODE"

http POST "$API/auth/login" "" "{\"email\":\"$A_EMAIL\",\"password\":\"wrong\"}"
assert "login wrong password" 401 "$CODE"

http POST "$API/auth/login" "" "{\"email\":\"$A_EMAIL\",\"password\":\"pass1234\"}"
assert "login Alice" 200 "$CODE"
TA=$(jq_get "$BODY" token)
http POST "$API/auth/login" "" "{\"email\":\"$B_EMAIL\",\"password\":\"pass1234\"}"
TB=$(jq_get "$BODY" token)
http POST "$API/auth/login" "" "{\"email\":\"$C_EMAIL\",\"password\":\"pass1234\"}"
TC=$(jq_get "$BODY" token)

http GET "$API/me" ""
assert "GET /me without token" 401 "$CODE"

http GET "$API/me" "garbage"
assert "GET /me with invalid token" 401 "$CODE"

http GET "$API/me" "$TA"
assert "GET /me Alice" 200 "$CODE"

# ------------- §4.2 Accounts -------------
section "Accounts"

http GET "$API/accounts" "$TA"
assert "list accounts (empty)" 200 "$CODE"

http POST "$API/accounts" "$TA" '{"type":"checking"}'
assert "Alice creates checking" 201 "$CODE"
A1=$(jq_get "$BODY" id)
http POST "$API/accounts" "$TA" '{"type":"savings"}'
assert "Alice creates savings" 201 "$CODE"
A2=$(jq_get "$BODY" id)
http POST "$API/accounts" "$TB" '{"type":"checking"}'
B1=$(jq_get "$BODY" id)
http POST "$API/accounts" "$TC" '{"type":"checking"}'
C1=$(jq_get "$BODY" id)

http POST "$API/accounts" "$TA" '{"type":"crypto"}'
assert "create with bad type" 400 "$CODE"

http GET "$API/accounts/$A1" "$TA"
assert "Alice gets her checking" 200 "$CODE"

http GET "$API/accounts/$A1" "$TB"
assert "Bob gets Alice account -> 403" 403 "$CODE"

http GET "$API/accounts/does-not-exist" "$TA"
assert "GET non-existent account -> 404" 404 "$CODE"

http PATCH "$API/accounts/$A2" "$TA" '{"status":"frozen"}'
assert "freeze own account" 200 "$CODE"
http PATCH "$API/accounts/$A2" "$TA" '{"status":"active"}'
assert "unfreeze own account" 200 "$CODE"
http PATCH "$API/accounts/$A2" "$TA" '{"status":"closed"}'
assert "PATCH to closed rejected" 409 "$CODE"

# ------------- §4.3 Transactions -------------
section "Transactions"

http POST "$API/accounts/$A1/deposit" "$TA" '{"amount":"50000.00","description":"seed"}'
assert "deposit 50000 to Alice checking" 201 "$CODE"

http POST "$API/accounts/$A1/deposit" "$TA" '{"amount":"-1"}'
assert "deposit negative -> 400" 400 "$CODE"

http POST "$API/accounts/$A1/deposit" "$TA" '{"amount":"0"}'
assert "deposit zero -> 400" 400 "$CODE"

http POST "$API/accounts/$A1/withdraw" "$TA" '{"amount":"100.00"}'
assert "withdraw 100" 201 "$CODE"

http POST "$API/accounts/$A1/withdraw" "$TA" '{"amount":"99999999.00"}'
assert "withdraw insufficient -> 409" 409 "$CODE"

http POST "$API/accounts/$B1/deposit" "$TA" '{"amount":"10"}'
assert "Alice deposits to Bob -> 403" 403 "$CODE"

# Freeze, then deposit blocked
http PATCH "$API/accounts/$A2" "$TA" '{"status":"frozen"}' > /dev/null
http POST "$API/accounts/$A2/deposit" "$TA" '{"amount":"1.00"}'
assert "deposit to frozen own account -> 409" 409 "$CODE"
http PATCH "$API/accounts/$A2" "$TA" '{"status":"active"}' > /dev/null

http GET "$API/accounts/$A1/transactions?limit=5&offset=0" "$TA"
assert "list transactions" 200 "$CODE"

# ------------- §4.4 Transfers -------------
section "Transfers"

http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$C1\",\"amount\":\"100.00\",\"description\":\"to Carol\"}"
assert "transfer Alice->Carol 100" 201 "$CODE"
T1=$(jq_get "$BODY" id)

http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$A1\",\"amount\":\"1.00\"}"
assert "transfer to same account -> 409" 409 "$CODE"

http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$C1\",\"amount\":\"-1.00\"}"
assert "transfer negative -> 400" 400 "$CODE"

http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$B1\",\"toAccountId\":\"$C1\",\"amount\":\"1.00\"}"
assert "transfer from Bob's account as Alice -> 403" 403 "$CODE"

http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"does-not-exist\",\"amount\":\"1.00\"}"
assert "transfer to non-existent dest -> 404" 404 "$CODE"

http GET "$API/transfers/$T1" "$TA"
assert "Alice (from-owner) sees transfer" 200 "$CODE"

http GET "$API/transfers/$T1" "$TC"
assert "Carol (to-owner) sees transfer" 200 "$CODE"

http GET "$API/transfers/$T1" "$TB"
assert "Bob (third party) -> 403" 403 "$CODE"

# Reverse path: only from-owner; transfer must be posted; within 24h
http POST "$API/transfers/$T1/reverse" "$TC" ''
assert "Carol cannot reverse -> 403" 403 "$CODE"

http POST "$API/transfers/$T1/reverse" "$TA" ''
assert "Alice reverses transfer" 200 "$CODE"

http POST "$API/transfers/$T1/reverse" "$TA" ''
assert "reverse already-reversed -> 409" 409 "$CODE"

# Source frozen rejection
http PATCH "$API/accounts/$A2" "$TA" '{"status":"frozen"}' > /dev/null
http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$A2\",\"toAccountId\":\"$C1\",\"amount\":\"1.00\"}"
assert "transfer from frozen source -> 409" 409 "$CODE"
http PATCH "$API/accounts/$A2" "$TA" '{"status":"active"}' > /dev/null

# Batch
BATCH_OK="{\"atomicity\":\"best-effort\",\"transfers\":[
  {\"fromAccountId\":\"$A1\",\"toAccountId\":\"$C1\",\"amount\":\"5.00\",\"metadata\":{\"memo\":\"a\"}},
  {\"fromAccountId\":\"$A1\",\"toAccountId\":\"$C1\",\"amount\":\"6.00\"}
]}"
http POST "$API/transfers/batch" "$TA" "$BATCH_OK"
assert "batch best-effort 2 ok" 200 "$CODE"

# all-or-nothing: include one bad item, expect zero applied
BATCH_AON_BAD="{\"atomicity\":\"all-or-nothing\",\"transfers\":[
  {\"fromAccountId\":\"$A1\",\"toAccountId\":\"$C1\",\"amount\":\"7.00\"},
  {\"fromAccountId\":\"$A1\",\"toAccountId\":\"$A1\",\"amount\":\"1.00\"}
]}"
http POST "$API/transfers/batch" "$TA" "$BATCH_AON_BAD"
assert "batch all-or-nothing with bad item -> 200" 200 "$CODE"
SUCCEEDED=$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['summary']['succeeded'])" "$BODY")
assert "  succeeded=0 because rolled back" 0 "$SUCCEEDED"

# > 50 -> 413
HUGE=$(python3 -c "
import json
arr=[{'fromAccountId':'$A1','toAccountId':'$C1','amount':'1'}]*51
print(json.dumps({'atomicity':'best-effort','transfers':arr}))")
http POST "$API/transfers/batch" "$TA" "$HUGE"
assert "batch >50 -> 413" 413 "$CODE"

# ------------- §4.5 Statements -------------
section "Statements"

TODAY=$(date -u +%Y-%m-%d)
http GET "$API/accounts/$A1/statement?from=$TODAY&to=$TODAY" "$TA"
assert "statement today" 200 "$CODE"

http GET "$API/accounts/$A1/statement?from=$TODAY" "$TA"
assert "statement missing to -> 400" 400 "$CODE"

http GET "$API/accounts/$A1/statement?from=$TODAY&to=$TODAY" "$TB"
assert "statement for other user -> 403" 403 "$CODE"

# ------------- §5 / §6 Defects -------------
section "Intentional defects"

# Defect #1: frozen destination accepts transfer
http PATCH "$API/accounts/$C1" "$TC" '{"status":"frozen"}' > /dev/null
http POST "$API/transfers" "$TA" "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$C1\",\"amount\":\"3.00\"}"
assert "DEFECT #1: frozen dest accepts (buggy 201; spec wants 409)" 201 "$CODE"
http PATCH "$API/accounts/$C1" "$TC" '{"status":"active"}' > /dev/null

# Defect #2: pump the limit, reverse, then try one cent
# Use a fresh user/account so we don't conflict with the rest of the script.
D_EMAIL="dave+${STAMP}@bank.io"
http POST "$API/auth/register" "" "{\"email\":\"$D_EMAIL\",\"name\":\"Dave\",\"password\":\"pass1234\"}" > /dev/null
http POST "$API/auth/login" "" "{\"email\":\"$D_EMAIL\",\"password\":\"pass1234\"}"
TD=$(jq_get "$BODY" token)
http POST "$API/accounts" "$TD" '{"type":"checking"}'
D1=$(jq_get "$BODY" id)
http POST "$API/accounts/$D1/deposit" "$TD" '{"amount":"50000"}' > /dev/null
http POST "$API/transfers" "$TD" "{\"fromAccountId\":\"$D1\",\"toAccountId\":\"$C1\",\"amount\":\"9990.00\"}"
T_REV=$(jq_get "$BODY" id)
http POST "$API/transfers/$T_REV/reverse" "$TD" ''
http POST "$API/transfers" "$TD" "{\"fromAccountId\":\"$D1\",\"toAccountId\":\"$C1\",\"amount\":\"50.00\"}"
assert "DEFECT #2: reverse still counts (buggy 409; spec wants 201)" 409 "$CODE"

# ------------- Account closure -------------
section "Account closure"

# Carol's account has balance now; closing should fail
http DELETE "$API/accounts/$C1" "$TC" ''
assert "close account with balance -> 409" 409 "$CODE"

# Carol opens a fresh empty account and closes it
http POST "$API/accounts" "$TC" '{"type":"savings"}'
C2=$(jq_get "$BODY" id)
http DELETE "$API/accounts/$C2" "$TC" ''
assert "close empty account -> 204" 204 "$CODE"

# ------------- Summary -------------
echo
printf '\033[1mPASS=%d  FAIL=%d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
