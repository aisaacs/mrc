#!/bin/bash
set -euo pipefail

# video-analysis — Extract frames from video files for visual analysis.
# Wraps ffmpeg to extract frames, generate a contact sheet, and write a manifest.

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
CONFIG="/workspace/.mrc/video-analysis.json"

# --- Built-in defaults ---
MODE="scene"
INTERVAL="1"
SCENE_THRESH="0.3"
TIMESTAMPS=""
WIDTH="1280"
MAX_FRAMES="50"
BUDGET="8"
CONTACT_SHEET="yes"
MANIFEST="yes"
OUTPUT=""
SOURCE=""

# --- Config reading (node -p, coerce null/undefined to empty) ---
read_config() {
  node -p "const v=(()=>{try{return JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).$1}catch{return null}})();v==null?'':v" 2>/dev/null || true
}

# --- Usage ---
usage() {
  cat <<'EOF'
Usage: video-analysis [OPTIONS] <video-path-or-url>

Extract frames from a video file for visual analysis by Claude.

Options:
  -m, --mode <mode>       Extraction mode: scene (default), interval, keyframe, timestamp
  -i, --interval <fps>    Frames per second for interval mode (default: 1)
  -t, --timestamp <ts>    Comma-separated timestamps for timestamp mode (e.g., "0:42,1:15")
  -s, --scene <thresh>    Scene change threshold for scene mode (default: 0.3)
  -o, --output <dir>      Output directory (default: /workspace/video-analysis-output/<basename>)
  -w, --width <px>        Max width for downscaling (default: 1280)
  -n, --max-frames <n>    Maximum number of frames to extract (default: 50)
  -b, --budget <n>        Viewing budget hint in manifest (default: 8)
  --no-contact-sheet      Skip contact sheet generation
  --no-manifest           Skip manifest.json generation
  -h, --help              Show this help

Config resolution (highest wins):
  CLI flags > .mrc/video-analysis.json > MRC_VIDEO_* env vars > built-in defaults

Examples:
  video-analysis /workspace/recording.mp4
  video-analysis --mode interval --interval 0.5 /workspace/demo.mov
  video-analysis --mode timestamp --timestamp "0:42,1:15,2:30" /workspace/repro.mp4
  video-analysis https://example.com/video.mp4   # requires mrc --web

Subcommands:
  video-analysis zoom <frame> ...   Crop and upscale a region of an extracted frame
EOF
}

# --- Zoom subcommand: crop + upscale a region of a frame ---
zoom_usage() {
  cat <<'EOF'
Usage: video-analysis zoom <frame-path> [OPTIONS]

Crop and upscale a region of an extracted frame. Useful when small text is
hard to read at default resolution. Uses Lanczos scaling for sharp edges.

Options:
  --region <name>         Named region (default: CENTER)
                          TOP | BOTTOM | LEFT | RIGHT | CENTER
                          TOP_LEFT | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_RIGHT
  --crop X,Y,W,H          Explicit pixel crop (overrides --region)
  --scale <n>             Upscale factor (default: 3)
  -o, --output <path>     Output path (default: <frame>_zoom_<region>.jpg)
  -h, --help              Show this help

Examples:
  video-analysis zoom frame_0033.jpg --region TOP
  video-analysis zoom frame_0033.jpg --crop 100,50,400,200 --scale 4
  video-analysis zoom frame_0033.jpg --region CENTER --scale 2

Note: Zoom sharpens edges but cannot recover detail that isn't in the source.
If the source video was low quality, zoom may not help — in that case, say so
rather than guessing at ambiguous characters.
EOF
}

run_zoom() {
  local frame="" region="CENTER" crop="" scale="3" output=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --region)    region="$2"; shift 2 ;;
      --crop)      crop="$2"; shift 2 ;;
      --scale)     scale="$2"; shift 2 ;;
      -o|--output) output="$2"; shift 2 ;;
      -h|--help)   zoom_usage; exit 0 ;;
      -*)          echo "Unknown option: $1" >&2; zoom_usage >&2; exit 1 ;;
      *)           frame="$1"; shift ;;
    esac
  done

  [[ -z "$frame" ]] && { echo "Error: no frame specified" >&2; zoom_usage >&2; exit 1; }
  [[ -f "$frame" ]] || { echo "Error: frame not found: $frame" >&2; exit 1; }

  # Get frame dimensions
  local dims iw ih
  dims=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$frame" | head -1)
  iw="${dims%,*}"
  ih="${dims#*,}"

  local cx cy cw ch
  if [[ -n "$crop" ]]; then
    IFS=',' read -r cx cy cw ch <<< "$crop"
  else
    case "$region" in
      TOP)          cx=0;                  cy=0;                  cw=$iw;                  ch=$((ih * 25 / 100)) ;;
      BOTTOM)       cx=0;                  cy=$((ih * 75 / 100)); cw=$iw;                  ch=$((ih * 25 / 100)) ;;
      LEFT)         cx=0;                  cy=0;                  cw=$((iw * 35 / 100));   ch=$ih ;;
      RIGHT)        cx=$((iw * 65 / 100)); cy=0;                  cw=$((iw * 35 / 100));   ch=$ih ;;
      CENTER)       cx=$((iw * 25 / 100)); cy=$((ih * 25 / 100)); cw=$((iw * 50 / 100));   ch=$((ih * 50 / 100)) ;;
      TOP_LEFT)     cx=0;                  cy=0;                  cw=$((iw * 50 / 100));   ch=$((ih * 50 / 100)) ;;
      TOP_RIGHT)    cx=$((iw * 50 / 100)); cy=0;                  cw=$((iw * 50 / 100));   ch=$((ih * 50 / 100)) ;;
      BOTTOM_LEFT)  cx=0;                  cy=$((ih * 50 / 100)); cw=$((iw * 50 / 100));   ch=$((ih * 50 / 100)) ;;
      BOTTOM_RIGHT) cx=$((iw * 50 / 100)); cy=$((ih * 50 / 100)); cw=$((iw * 50 / 100));   ch=$((ih * 50 / 100)) ;;
      *)            echo "Error: unknown region: $region" >&2; zoom_usage >&2; exit 1 ;;
    esac
  fi

  if [[ -z "$output" ]]; then
    local base="${frame%.*}"
    local ext="${frame##*.}"
    local tag
    [[ -n "$crop" ]] && tag="zoom" || tag="zoom_$(echo "$region" | tr '[:upper:]' '[:lower:]')"
    output="${base}_${tag}.${ext}"
  fi

  ffmpeg -v warning -y -i "$frame" \
    -vf "crop=${cw}:${ch}:${cx}:${cy},scale=iw*${scale}:ih*${scale}:flags=lanczos" \
    "$output"

  echo "Zoomed: $output"
  echo "Region: ${cw}x${ch} at (${cx},${cy}) from ${iw}x${ih}, scaled ${scale}x"
}

# --- Subcommand dispatch ---
if [[ "${1:-}" == "zoom" ]]; then
  shift
  run_zoom "$@"
  exit 0
fi

# --- Resolve config: flag > JSON > env > built-in ---
resolve_config() {
  local cfg_mode cfg_interval cfg_scene cfg_width cfg_max cfg_budget

  cfg_mode="$(read_config mode)"
  cfg_interval="$(read_config interval)"
  cfg_scene="$(read_config scene_threshold)"
  cfg_width="$(read_config width)"
  cfg_max="$(read_config max_frames)"
  cfg_budget="$(read_config budget)"

  # Only override if not set by flag (FLAG_* vars set during arg parsing)
  MODE="${FLAG_MODE:-${cfg_mode:-${MRC_VIDEO_MODE:-$MODE}}}"
  INTERVAL="${FLAG_INTERVAL:-${cfg_interval:-${MRC_VIDEO_INTERVAL:-$INTERVAL}}}"
  SCENE_THRESH="${FLAG_SCENE:-${cfg_scene:-${MRC_VIDEO_SCENE_THRESH:-$SCENE_THRESH}}}"
  WIDTH="${FLAG_WIDTH:-${cfg_width:-${MRC_VIDEO_WIDTH:-$WIDTH}}}"
  MAX_FRAMES="${FLAG_MAX:-${cfg_max:-${MRC_VIDEO_MAX_FRAMES:-$MAX_FRAMES}}}"
  BUDGET="${FLAG_BUDGET:-${cfg_budget:-${MRC_VIDEO_BUDGET:-$BUDGET}}}"
}

# --- Parse args ---
FLAG_MODE="" FLAG_INTERVAL="" FLAG_SCENE="" FLAG_WIDTH="" FLAG_MAX="" FLAG_BUDGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--mode)      FLAG_MODE="$2"; shift 2 ;;
    -i|--interval)  FLAG_INTERVAL="$2"; shift 2 ;;
    -t|--timestamp) TIMESTAMPS="$2"; shift 2 ;;
    -s|--scene)     FLAG_SCENE="$2"; shift 2 ;;
    -o|--output)    OUTPUT="$2"; shift 2 ;;
    -w|--width)     FLAG_WIDTH="$2"; shift 2 ;;
    -n|--max-frames) FLAG_MAX="$2"; shift 2 ;;
    -b|--budget)    FLAG_BUDGET="$2"; shift 2 ;;
    --no-contact-sheet) CONTACT_SHEET="no"; shift ;;
    --no-manifest)  MANIFEST="no"; shift ;;
    -h|--help)      usage; exit 0 ;;
    -*)             echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)              SOURCE="$1"; shift ;;
  esac
done

if [[ -z "$SOURCE" ]]; then
  echo "Error: no video source specified" >&2
  usage >&2
  exit 1
fi

# Force timestamp mode if timestamps were provided
if [[ -n "$TIMESTAMPS" ]]; then
  FLAG_MODE="timestamp"
fi

# Resolve config layers
resolve_config

# --- Input resolution ---
INPUT="$SOURCE"
DOWNLOADED=""
cleanup_download() {
  [[ -n "$DOWNLOADED" ]] && rm -f "$DOWNLOADED"
}
trap cleanup_download EXIT

if [[ "$SOURCE" =~ ^https?:// ]]; then
  DOWNLOADED=$(mktemp /tmp/mrc-video-dl.XXXXXX)
  echo "Downloading $SOURCE..."
  if ! curl -fsSL -o "$DOWNLOADED" "$SOURCE"; then
    echo "Error: download failed." >&2
    echo "If running behind the mrc firewall, start with: mrc --web" >&2
    exit 1
  fi
  INPUT="$DOWNLOADED"
else
  if [[ ! -f "$SOURCE" ]]; then
    echo "Error: file not found: $SOURCE" >&2
    exit 1
  fi
fi

# --- Validate input is a video ---
if ! ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT" &>/dev/null; then
  echo "Error: not a valid video file: $SOURCE" >&2
  exit 1
fi

# --- Output directory ---
if [[ -z "$OUTPUT" ]]; then
  # Use the video's basename (no extension) for a human-readable path
  BASE=$(basename "$SOURCE" | sed 's/[?#].*//; s/\.[^.]*$//')
  [[ -z "$BASE" ]] && BASE=$(echo -n "$SOURCE" | md5sum | cut -c1-12)
  OUTPUT="/workspace/video-analysis-output/$BASE"
fi
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"

# Ensure video-analysis-output/ is gitignored
if [[ "$OUTPUT" == /workspace/video-analysis-output/* ]] && [[ -d /workspace/.git ]]; then
  if ! grep -qxF 'video-analysis-output/' /workspace/.gitignore 2>/dev/null; then
    echo 'video-analysis-output/' >> /workspace/.gitignore
  fi
fi

# --- Get video metadata ---
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT")
RESOLUTION=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$INPUT" | head -1 | tr ',' 'x')
DURATION_INT=$(printf '%.0f' "$DURATION")
DURATION_FMT=$(printf '%dm%02ds' $((DURATION_INT / 60)) $((DURATION_INT % 60)))

echo "Source: $(basename "$SOURCE") (${DURATION_FMT}, ${RESOLUTION})"

# --- Extract frames ---
extract_frames() {
  local mode="$1"
  local log="$OUTPUT/.extract_log"

  case "$mode" in
    scene)
      echo "Extracting frames (scene detection, threshold=$SCENE_THRESH)..."
      ffmpeg -v warning -i "$INPUT" \
        -vf "select='gt(scene,$SCENE_THRESH)',showinfo,scale='min($WIDTH,iw)':-1" \
        -vsync vfr "$OUTPUT/frame_%04d.jpg" 2>"$log"
      ;;
    interval)
      echo "Extracting frames (${INTERVAL} fps)..."
      ffmpeg -v warning -i "$INPUT" \
        -vf "fps=$INTERVAL,showinfo,scale='min($WIDTH,iw)':-1" \
        "$OUTPUT/frame_%04d.jpg" 2>"$log"
      ;;
    keyframe)
      echo "Extracting keyframes..."
      ffmpeg -v warning -i "$INPUT" \
        -vf "select='eq(pict_type\,I)',showinfo,scale='min($WIDTH,iw)':-1" \
        -vsync vfr "$OUTPUT/frame_%04d.jpg" 2>"$log"
      ;;
    timestamp)
      echo "Extracting frames at specified timestamps..."
      IFS=',' read -ra TS_ARR <<< "$TIMESTAMPS"
      local idx=1
      for ts in "${TS_ARR[@]}"; do
        ts=$(echo "$ts" | tr -d ' ')
        ffmpeg -v warning -ss "$ts" -i "$INPUT" \
          -vf "showinfo,scale='min($WIDTH,iw)':-1" \
          -frames:v 1 "$OUTPUT/frame_$(printf '%04d' $idx).jpg" 2>>"$log"
        ((idx++))
      done
      ;;
    *)
      echo "Error: unknown extraction mode: $mode" >&2
      exit 1
      ;;
  esac
}

extract_frames "$MODE"

# --- Count extracted frames ---
FRAME_COUNT=$(find "$OUTPUT" -maxdepth 1 -name 'frame_*.jpg' | wc -l)

# --- Scene detection fallback ---
# Trigger if scene mode returns suspiciously few frames for the video length.
# Heuristic: expect at least 1 frame per ~15 seconds of content. If the result
# is dramatically below that and the video is non-trivial, retry with interval.
if [[ "$MODE" == "scene" ]]; then
  EXPECTED_MIN=$(awk "BEGIN { printf \"%d\", ($DURATION / 15) }")
  (( EXPECTED_MIN < 2 )) && EXPECTED_MIN=2
  if (( FRAME_COUNT < EXPECTED_MIN )) && (( DURATION_INT > 10 )); then
    echo "Warning: scene detection found only $FRAME_COUNT frames in ${DURATION_FMT}. Retrying with interval mode (1 fps)..."
    rm -f "$OUTPUT"/frame_*.jpg
    MODE="interval"
    INTERVAL="1"
    extract_frames "$MODE"
    FRAME_COUNT=$(find "$OUTPUT" -maxdepth 1 -name 'frame_*.jpg' | wc -l)
  fi
fi

if [[ "$FRAME_COUNT" -eq 0 ]]; then
  echo "Error: no frames extracted from video" >&2
  exit 1
fi

# --- Safety cap ---
if (( FRAME_COUNT > MAX_FRAMES )); then
  echo "Warning: $FRAME_COUNT frames exceeds cap of $MAX_FRAMES, selecting evenly spaced subset..."
  mapfile -t ALL_FRAMES < <(ls "$OUTPUT"/frame_*.jpg | sort)
  STEP=$(( FRAME_COUNT / MAX_FRAMES ))
  KEEP=()
  for ((i = 0; i < FRAME_COUNT && ${#KEEP[@]} < MAX_FRAMES; i += STEP)); do
    KEEP+=("${ALL_FRAMES[$i]}")
  done

  # Remove frames not in KEEP
  for f in "${ALL_FRAMES[@]}"; do
    local_keep=false
    for k in "${KEEP[@]}"; do
      [[ "$f" == "$k" ]] && { local_keep=true; break; }
    done
    $local_keep || rm -f "$f"
  done

  # Re-number sequentially
  idx=1
  for f in "${KEEP[@]}"; do
    new_name="$OUTPUT/frame_$(printf '%04d' $idx).jpg"
    [[ "$f" != "$new_name" ]] && mv "$f" "$new_name"
    ((idx++))
  done
  FRAME_COUNT=${#KEEP[@]}
fi

echo "Extracted $FRAME_COUNT frames"

# --- Parse timestamps from showinfo log ---
declare -a FRAME_TIMESTAMPS=()
if [[ "$MODE" == "timestamp" ]]; then
  IFS=',' read -ra FRAME_TIMESTAMPS <<< "$TIMESTAMPS"
  # Trim spaces
  for ((i = 0; i < ${#FRAME_TIMESTAMPS[@]}; i++)); do
    FRAME_TIMESTAMPS[$i]=$(echo "${FRAME_TIMESTAMPS[$i]}" | tr -d ' ')
  done
else
  if [[ -f "$OUTPUT/.extract_log" ]]; then
    # Use grep -o + sed (portable, no PCRE -P dependency)
    mapfile -t FRAME_TIMESTAMPS < <(
      grep -oE 'pts_time:[0-9.]+' "$OUTPUT/.extract_log" | sed 's/pts_time://' | head -n "$FRAME_COUNT"
    )
  fi
fi

# --- Format a raw timestamp (seconds) as MM:SS ---
format_ts() {
  local raw="$1"
  # Handle already-formatted timestamps (e.g., 0:42)
  if [[ "$raw" == *:* ]]; then
    echo "$raw"
    return
  fi
  local secs
  secs=$(printf '%.0f' "$raw" 2>/dev/null || echo "0")
  printf '%d:%02d' $((secs / 60)) $((secs % 60))
}

# --- Contact sheet ---
if [[ "$CONTACT_SHEET" == "yes" && "$FRAME_COUNT" -gt 0 ]]; then
  echo "Generating contact sheet..."

  # Annotate each frame with label.
  # Use drawtext's `textfile=` option (reads text from a file) instead of
  # inline `text=`. This avoids ALL command-line escaping issues — colons,
  # spaces, special chars in the label all just work because they're never
  # parsed by the filter syntax.
  ANNOTATE_LOG="$OUTPUT/.annotate_log"
  : > "$ANNOTATE_LOG"
  for i in $(seq 1 "$FRAME_COUNT"); do
    f="$OUTPUT/frame_$(printf '%04d' $i).jpg"
    raw_ts="${FRAME_TIMESTAMPS[$((i-1))]:-0}"
    ts_fmt=$(format_ts "$raw_ts")
    label="#$i  $ts_fmt"

    label_file="$OUTPUT/.label_$(printf '%04d' $i).txt"
    printf '%s' "$label" > "$label_file"

    drawtext_filter="drawtext=textfile=${label_file}:fontfile=${FONT}:fontsize=18:fontcolor=white:borderw=2:bordercolor=black@0.8:x=5:y=h-28"

    if ! ffmpeg -v warning -i "$f" -vf "$drawtext_filter" -y "$OUTPUT/.labeled_$(printf '%04d' $i).jpg" 2>>"$ANNOTATE_LOG"; then
      echo "Warning: failed to annotate frame $i" >&2
    fi
  done

  # Clean up label text files
  rm -f "$OUTPUT"/.label_*.txt

  LABELED_COUNT=$(find "$OUTPUT" -maxdepth 1 -name '.labeled_*.jpg' | wc -l)
  if (( LABELED_COUNT < FRAME_COUNT )); then
    echo "Warning: only $LABELED_COUNT/$FRAME_COUNT frames annotated. drawtext errors:" >&2
    head -20 "$ANNOTATE_LOG" >&2
  fi
  rm -f "$ANNOTATE_LOG"

  if (( LABELED_COUNT == 1 )); then
    # Single frame: no tiling needed
    cp "$OUTPUT"/.labeled_*.jpg "$OUTPUT/contact_sheet.jpg"
  elif (( LABELED_COUNT == 0 )); then
    echo "Warning: no labeled frames available; skipping contact sheet" >&2
  else
    # Calculate grid dimensions (cap at 8 cols for reasonable contact sheet width)
    COLS=$(awk "BEGIN { printf \"%d\", sqrt($LABELED_COUNT) + 0.999 }")
    [[ "$COLS" -lt 2 ]] && COLS=2
    [[ "$COLS" -gt 8 ]] && COLS=8
    ROWS=$(( (LABELED_COUNT + COLS - 1) / COLS ))

    # Tile labeled frames into grid.
    # -update 1 is required: ffmpeg's image2 muxer treats .jpg output as a
    # sequence pattern by default; -update 1 forces single-image output.
    if ! ffmpeg -v warning -framerate 1 \
        -pattern_type glob -i "$OUTPUT/.labeled_*.jpg" \
        -vf "scale=320:-1,tile=${COLS}x${ROWS}:padding=4:margin=4:color=0x333333" \
        -frames:v 1 -update 1 -y "$OUTPUT/contact_sheet.jpg" 2>"$OUTPUT/.contact_sheet_log"; then
      echo "Warning: contact sheet generation failed. ffmpeg error:" >&2
      cat "$OUTPUT/.contact_sheet_log" >&2
      rm -f "$OUTPUT/.contact_sheet_log"
    fi
  fi

  # Clean up intermediates
  rm -f "$OUTPUT"/.labeled_*.jpg "$OUTPUT/.contact_sheet_log"

  if [[ -f "$OUTPUT/contact_sheet.jpg" ]]; then
    echo "Contact sheet: $OUTPUT/contact_sheet.jpg"
  fi
fi

# --- Manifest ---
if [[ "$MANIFEST" == "yes" ]]; then
  {
    echo "{"
    echo "  \"source\": \"$SOURCE\","
    echo "  \"duration\": \"$DURATION_FMT\","
    echo "  \"duration_seconds\": $DURATION,"
    echo "  \"resolution\": \"$RESOLUTION\","
    echo "  \"extraction_mode\": \"$MODE\","
    if [[ "$MODE" == "scene" ]]; then
      echo "  \"extraction_params\": { \"threshold\": $SCENE_THRESH },"
    elif [[ "$MODE" == "interval" ]]; then
      echo "  \"extraction_params\": { \"fps\": $INTERVAL },"
    fi
    echo "  \"frame_count\": $FRAME_COUNT,"
    echo "  \"budget\": $BUDGET,"
    echo "  \"contact_sheet\": \"$OUTPUT/contact_sheet.jpg\","
    echo "  \"output_dir\": \"$OUTPUT\","
    echo "  \"frames\": ["
    for i in $(seq 1 "$FRAME_COUNT"); do
      raw_ts="${FRAME_TIMESTAMPS[$((i-1))]:-0}"
      ts_fmt=$(format_ts "$raw_ts")
      COMMA=","
      (( i == FRAME_COUNT )) && COMMA=""
      echo "    { \"file\": \"frame_$(printf '%04d' $i).jpg\", \"timestamp\": \"$raw_ts\", \"timestamp_fmt\": \"$ts_fmt\", \"index\": $i }$COMMA"
    done
    echo "  ]"
    echo "}"
  } > "$OUTPUT/manifest.json"
fi

# --- Summary ---
echo ""
echo "Extracted $FRAME_COUNT frames from $(basename "$SOURCE") ($DURATION_FMT, $MODE mode)"
echo "Output: $OUTPUT/"
[[ -f "$OUTPUT/contact_sheet.jpg" ]] && echo "Contact sheet: $OUTPUT/contact_sheet.jpg"
[[ -f "$OUTPUT/manifest.json" ]] && echo "Manifest: $OUTPUT/manifest.json"
