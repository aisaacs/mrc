#!/usr/bin/env node
// pick-session.js — List sessions from S3, pick one to resume.
// Uses curl for AWS Sig V4 auth, node for XML/JSON parsing and UI.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const S3_BUCKET = process.env.MRC_S3_BUCKET;
const S3_PREFIX = process.env.MRC_S3_PREFIX || "sessions";
const S3_REGION = process.env.AWS_DEFAULT_REGION || "us-east-1";
const S3_HOST = `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
const SESSION_DIR =
  process.env.MRC_SESSION_DEST || require("os").tmpdir() + "/mrc-sessions";

if (!S3_BUCKET) {
  console.error("MRC_S3_BUCKET is not set");
  process.exit(1);
}

function s3curl(s3Path, extraArgs = "") {
  const tokenHeader = process.env.AWS_SESSION_TOKEN
    ? `-H "x-amz-security-token: ${process.env.AWS_SESSION_TOKEN}"`
    : "";
  const cmd = `curl -sf --aws-sigv4 "aws:amz:${S3_REGION}:s3" \
    --user "${process.env.AWS_ACCESS_KEY_ID}:${process.env.AWS_SECRET_ACCESS_KEY}" \
    ${tokenHeader} ${extraArgs} \
    "https://${S3_HOST}${s3Path}"`;
  return execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function listObjects() {
  const xml = s3curl(`/?list-type=2&prefix=${encodeURIComponent(S3_PREFIX + "/")}`);
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1].endsWith(".jsonl")) keys.push(m[1]);
  }
  return keys;
}

function peekSession(key) {
  // Download first 8KB to extract metadata
  try {
    const data = s3curl(`/${key}`, '-H "Range: bytes=0-8191"');
    const lines = data.split("\n").filter(Boolean);
    let slug = null;
    let timestamp = null;
    let sessionId = null;
    let firstMessage = null;
    let gitBranch = null;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && obj.message?.role === "user") {
          if (!sessionId) {
            sessionId = obj.sessionId;
            slug = obj.slug;
            timestamp = obj.timestamp;
            gitBranch = obj.gitBranch;
          }
          if (!firstMessage) {
            const content = obj.message.content;
            if (typeof content === "string") {
              firstMessage = content;
            } else if (Array.isArray(content)) {
              const text = content.find((c) => c.type === "text");
              if (text) firstMessage = text.text;
            }
          }
        }
      } catch {}
    }

    return { key, sessionId, slug, timestamp, firstMessage, gitBranch };
  } catch {
    return { key, sessionId: null, slug: null, timestamp: null, firstMessage: null, gitBranch: null };
  }
}

function truncate(str, len) {
  if (!str) return "";
  str = str.replace(/\n/g, " ").trim();
  return str.length > len ? str.slice(0, len - 1) + "\u2026" : str;
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  process.stderr.write("Fetching sessions from S3...\n");

  const keys = listObjects();
  if (keys.length === 0) {
    console.error("No sessions found in s3://" + S3_BUCKET + "/" + S3_PREFIX + "/");
    process.exit(1);
  }

  process.stderr.write(`Found ${keys.length} session(s), loading metadata...\n\n`);

  const sessions = keys.map((k) => peekSession(k)).filter((s) => s.sessionId);

  // Sort by timestamp descending (newest first)
  sessions.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  // Display
  const colW = process.stderr.columns || 100;
  const msgW = Math.max(20, colW - 60);

  sessions.forEach((s, i) => {
    const date = s.timestamp
      ? new Date(s.timestamp).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        })
      : "unknown";
    const name = s.slug || s.sessionId.slice(0, 8);
    const branch = s.gitBranch ? `(${s.gitBranch})` : "";
    const msg = truncate(s.firstMessage, msgW);

    process.stderr.write(
      `  ${String(i + 1).padStart(3)})  ${date.padEnd(18)} ${name.padEnd(28)} ${branch}\n`
    );
    if (msg) {
      process.stderr.write(`       ${"\x1b[2m"}${msg}${"\x1b[0m"}\n`);
    }
  });

  process.stderr.write("\n");
  const answer = await prompt("Pick a session number (or q to quit): ");

  if (answer === "q" || answer === "") {
    process.exit(0);
  }

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
    console.error("Invalid selection");
    process.exit(1);
  }

  const selected = sessions[idx];
  const destFile = path.join(SESSION_DIR, `${selected.sessionId}.jsonl`);

  if (fs.existsSync(destFile)) {
    process.stderr.write(`Session already exists locally, resuming...\n`);
  } else {
    process.stderr.write(`Downloading session...\n`);
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const data = s3curl(`/${selected.key}`);
    fs.writeFileSync(destFile, data);
  }

  // Print session ID and file path to stdout so the caller can use them
  console.log(`${selected.sessionId}:${destFile}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
