#!/bin/bash
set -euo pipefail

# sync-sessions.sh — Background daemon that uploads Claude Code session files to S3.
# Polls for new/changed JSONL files and uploads them using curl with AWS Sig V4.
#
# Required env vars:
#   MRC_S3_BUCKET          — S3 bucket name
#   AWS_ACCESS_KEY_ID      — AWS credentials
#   AWS_SECRET_ACCESS_KEY  — AWS credentials
#
# Optional env vars:
#   MRC_S3_PREFIX          — Key prefix (default: "sessions")
#   AWS_DEFAULT_REGION     — AWS region (default: "us-east-1")
#   MRC_SYNC_INTERVAL      — Seconds between sync checks (default: 30)

S3_BUCKET="${MRC_S3_BUCKET:-}"
S3_PREFIX="${MRC_S3_PREFIX:-sessions}"
S3_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
SYNC_INTERVAL="${MRC_SYNC_INTERVAL:-30}"
SESSION_DIR="$HOME/.claude/projects"
SYNC_STATE_DIR="$HOME/.claude/sync-state"

if [ -z "$S3_BUCKET" ]; then
  exit 0
fi

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "sync-sessions: AWS credentials not set, skipping" >&2
  exit 0
fi

mkdir -p "$SYNC_STATE_DIR"

S3_HOST="${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com"

upload_file() {
  local file="$1"
  local s3_key="$2"
  local token_header=()

  if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
    token_header=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
  fi

  curl -sf --aws-sigv4 "aws:amz:${S3_REGION}:s3" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    "${token_header[@]+"${token_header[@]}"}" \
    -X PUT \
    -H "Content-Type: application/x-ndjson" \
    --data-binary "@${file}" \
    "https://${S3_HOST}/${s3_key}" >/dev/null
}

sync_sessions() {
  if [ ! -d "$SESSION_DIR" ]; then
    return
  fi

  # Find all session JSONL files
  find "$SESSION_DIR" -name '*.jsonl' -type f | while read -r file; do
    # Build a stable key from the relative path
    rel_path="${file#"$SESSION_DIR"/}"
    s3_key="${S3_PREFIX}/${rel_path}"

    # Track sync state using a marker file with the mtime
    marker="${SYNC_STATE_DIR}/${rel_path}.synced"
    file_mtime=$(stat -c %Y "$file")
    last_synced=$(cat "$marker" 2>/dev/null || echo "0")

    if [ "$file_mtime" != "$last_synced" ]; then
      if upload_file "$file" "$s3_key"; then
        mkdir -p "$(dirname "$marker")"
        echo "$file_mtime" > "$marker"
      else
        echo "sync-sessions: failed to upload ${rel_path}" >&2
      fi
    fi
  done
}

echo "sync-sessions: watching ${SESSION_DIR} -> s3://${S3_BUCKET}/${S3_PREFIX}/ (every ${SYNC_INTERVAL}s)"

while true; do
  sync_sessions
  sleep "$SYNC_INTERVAL"
done
