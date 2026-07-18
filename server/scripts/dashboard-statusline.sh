#!/bin/bash
# AI Multi-Instance injects this wrapper as the --settings statusLine override when
# it launches an instance (see server/src/launch.ts), so no per-profile install step is
# needed. It resolves whatever statusLine command the profile's own settings.json has
# configured (a script path, an inline one-liner, or none) and runs that as-is, so the
# terminal's visual output stays identical to what the user already had. On top of that
# it writes a parsed JSON snapshot keyed by the dashboard instance ID, so
# its sidebar can show live data (model, effort, branch, context usage, cost, rate
# limits, usage block) with its own logic and its own cache files, standalone: it does
# not depend on any specific third-party statusline script, so the sidebar works the
# same with or without one configured in the profile.

set -f

input=$(cat)
[ -z "$input" ] && { printf "Claude"; exit 0; }

model_name=$(echo "$input" | jq -r '.model.display_name // "Claude"')
cwd=$(echo "$input" | jq -r '.cwd // empty')
session_id=$(echo "$input" | jq -r '.session_id // empty')

claude_config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
settings_path="$claude_config_dir/settings.json"

# Resolve the profile's own statusLine (if any) and run it so the terminal's visual
# output is unaffected by this wrapper being injected on top of it. Guard against
# recursion in case a profile's settings.json somehow already points back at this file.
original_statusline=""
[ -f "$settings_path" ] && original_statusline=$(jq -r '.statusLine.command // empty' "$settings_path" 2>/dev/null)
if [ -n "$original_statusline" ] && [[ "$original_statusline" != *dashboard-statusline.sh* ]]; then
  printf "%s" "$input" | eval "$original_statusline" 2>/dev/null
elif [ -z "$original_statusline" ]; then
  printf "%s" "$model_name"
fi

# Nothing meaningful to key a snapshot on without a cwd
[ -z "$cwd" ] && exit 0

size=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
[ "$size" -eq 0 ] 2>/dev/null && size=200000
input_tokens=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // 0')
cache_create=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
used=$(( input_tokens + cache_create + cache_read ))
pct_used=$(( size > 0 ? used * 100 / size : 0 ))

effort_level=$(echo "$input" | jq -r '.effort.level // empty')
if [ -z "$effort_level" ] && [ -n "$CLAUDE_CODE_EFFORT_LEVEL" ]; then
  effort_level="$CLAUDE_CODE_EFFORT_LEVEL"
elif [ -z "$effort_level" ] && [ -f "$settings_path" ]; then
  effort_level=$(jq -r '.effortLevel // empty' "$settings_path" 2>/dev/null)
fi
[ -z "$effort_level" ] && effort_level="medium"

total_cost_usd=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
total_duration_ms=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')

git_branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
git_added=0
git_removed=0
if [ -n "$git_branch" ]; then
  read -r git_added git_removed <<< "$(git -C "$cwd" diff --numstat 2>/dev/null | awk '{a+=$1; d+=$2} END {printf "%d %d", a+0, d+0}')"
fi

five_hour_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_hour_resets_at=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
seven_day_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
seven_day_resets_at=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

# Usage-block extras: fetched/computed by this wrapper itself, with its own cache
# files distinct from the real statusline.sh's, so the sidebar never depends on
# whether (or when) that script has run.
extra_usd=""
extra_limit_usd=""
day_total_usd=""
burn_per_hour=""

cache_dir="$HOME/.cache/ai-multi-instance"
mkdir -p "$cache_dir"

get_oauth_token() {
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && { echo "$CLAUDE_CODE_OAUTH_TOKEN"; return; }
  if command -v security >/dev/null 2>&1; then
    local svc="Claude Code-credentials"
    if [ -n "$CLAUDE_CONFIG_DIR" ]; then
      svc="Claude Code-credentials-$(echo -n "$CLAUDE_CONFIG_DIR" | shasum -a 256 | cut -c1-8)"
    fi
    local blob token
    blob=$(security find-generic-password -s "$svc" -w 2>/dev/null)
    if [ -n "$blob" ]; then
      token=$(echo "$blob" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
      [ -n "$token" ] && [ "$token" != "null" ] && { echo "$token"; return; }
    fi
  fi
  local creds_file="${claude_config_dir}/.credentials.json"
  if [ -f "$creds_file" ]; then
    local token
    token=$(jq -r '.claudeAiOauth.accessToken // empty' "$creds_file" 2>/dev/null)
    [ -n "$token" ] && [ "$token" != "null" ] && { echo "$token"; return; }
  fi
  if command -v secret-tool >/dev/null 2>&1; then
    local blob token
    blob=$(timeout 2 secret-tool lookup service "Claude Code-credentials" 2>/dev/null)
    if [ -n "$blob" ]; then
      token=$(echo "$blob" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
      [ -n "$token" ] && [ "$token" != "null" ] && { echo "$token"; return; }
    fi
  fi
  echo ""
}

if [ -n "$five_hour_pct" ] || [ -n "$seven_day_pct" ]; then
  # Subscription account: extra usage credits, our own 60s cache
  dir_hash=$(echo -n "$claude_config_dir" | shasum -a 256 | cut -c1-8)
  extra_cache="${cache_dir}/extra-usage-${dir_hash}.json"
  extra_data=""
  refresh=true
  if [ -f "$extra_cache" ] && [ -s "$extra_cache" ]; then
    mtime=$(stat -f %m "$extra_cache" 2>/dev/null || stat -c %Y "$extra_cache" 2>/dev/null)
    age=$(( $(date +%s) - mtime ))
    [ "$age" -lt 60 ] && refresh=false
    extra_data=$(cat "$extra_cache")
  fi
  if $refresh; then
    touch "$extra_cache"
    token=$(get_oauth_token)
    if [ -n "$token" ]; then
      resp=$(curl -s --max-time 10 \
        -H "Accept: application/json" -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" -H "anthropic-beta: oauth-2025-04-20" \
        "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)
      if [ -n "$resp" ] && echo "$resp" | jq -e '.extra_usage' >/dev/null 2>&1; then
        extra_data="$resp"
        echo "$resp" > "$extra_cache"
      fi
    fi
    [ -f "$extra_cache" ] && [ ! -s "$extra_cache" ] && rm -f "$extra_cache"
  fi
  if [ -n "$extra_data" ]; then
    enabled=$(echo "$extra_data" | jq -r '.extra_usage.is_enabled // false' 2>/dev/null)
    if [ "$enabled" = "true" ]; then
      extra_usd=$(echo "$extra_data" | jq -r '.extra_usage.used_credits // 0' 2>/dev/null | LC_NUMERIC=C awk '{printf "%.2f", $1/100}')
      extra_limit_usd=$(echo "$extra_data" | jq -r '.extra_usage.monthly_limit // 0' 2>/dev/null | LC_NUMERIC=C awk '{printf "%.2f", $1/100}')
    fi
  fi
else
  if [ "$total_duration_ms" -gt 120000 ] 2>/dev/null; then
    burn_per_hour=$(awk -v c="$total_cost_usd" -v d="$total_duration_ms" 'BEGIN{printf "%.2f", c*3600000/d}')
  fi
  if [ -n "$session_id" ]; then
    # API key account: our own daily spend ledger, keyed by session_id like the original
    find "$cache_dir" -name 'daily-*.json' -mtime +7 -delete 2>/dev/null
    day_file="$cache_dir/daily-$(date +%Y-%m-%d).json"
    [ -f "$day_file" ] || echo '{}' > "$day_file"
    tmp_day_file=$(mktemp "${cache_dir}/.daily.XXXXXX")
    jq --arg sid "$session_id" --argjson cost "$total_cost_usd" '.[$sid] = $cost' "$day_file" > "$tmp_day_file" 2>/dev/null \
      && mv "$tmp_day_file" "$day_file" || rm -f "$tmp_day_file"
    day_total_usd=$(jq '[.[]] | add // 0' "$day_file" 2>/dev/null | awk '{printf "%.2f", $1}')
  fi
fi

snapshot_id="${AI_MULTI_INSTANCE_ID:-$(echo -n "$cwd" | shasum -a 256 | cut -c1-16)}"
tmp_file=$(mktemp "${cache_dir}/.snapshot.XXXXXX")

jq -n \
  --arg provider "claude" \
  --arg model "$model_name" \
  --arg cwd "$cwd" \
  --arg sessionId "$session_id" \
  --arg effort "$effort_level" \
  --arg branch "$git_branch" \
  --argjson gitAdded "$git_added" \
  --argjson gitRemoved "$git_removed" \
  --argjson contextUsed "$used" \
  --argjson contextSize "$size" \
  --argjson contextPct "$pct_used" \
  --argjson sessionCostUsd "$total_cost_usd" \
  --arg fiveHourPct "$five_hour_pct" \
  --arg fiveHourResetsAt "$five_hour_resets_at" \
  --arg sevenDayPct "$seven_day_pct" \
  --arg sevenDayResetsAt "$seven_day_resets_at" \
  --arg extraUsd "$extra_usd" \
  --arg extraLimitUsd "$extra_limit_usd" \
  --arg dayTotalUsd "$day_total_usd" \
  --arg burnPerHour "$burn_per_hour" \
  --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '
  # select() inside an object value would make the WHOLE object produce no
  # output whenever it filters that one field out; use if/then/else null instead
  def optStr: if . == "" then null else . end;
  def optNum: if . == "" then null else tonumber end;
  {
    provider: $provider,
    model: $model,
    cwd: $cwd,
    sessionId: ($sessionId | optStr),
    effort: $effort,
    branch: ($branch | optStr),
    gitAdded: $gitAdded,
    gitRemoved: $gitRemoved,
    contextUsed: $contextUsed,
    contextSize: $contextSize,
    contextPct: $contextPct,
    sessionCostUsd: $sessionCostUsd,
    fiveHourPct: ($fiveHourPct | optNum),
    fiveHourResetsAt: ($fiveHourResetsAt | optNum),
    sevenDayPct: ($sevenDayPct | optNum),
    sevenDayResetsAt: ($sevenDayResetsAt | optNum),
    extraUsd: ($extraUsd | optNum),
    extraLimitUsd: ($extraLimitUsd | optNum),
    dayTotalUsd: ($dayTotalUsd | optNum),
    burnPerHour: ($burnPerHour | optNum),
    updatedAt: $updatedAt
  }' > "$tmp_file" && mv "$tmp_file" "$cache_dir/${snapshot_id}.json"

exit 0
