---
description: >
  Analyze a video file by extracting frames. Suggest when the user references video
  files (.mp4, .mov, .avi, .mkv, .webm, .flv, .wmv, .m4v) or video URLs, or asks to
  "look at", "watch", "review", or "analyze" a recording. Always ask before running.
argument-hint: <video-path-or-url> [options]
allowed-tools: Bash(video-analysis*), Read
---

# Video Analysis

Analyze video files by extracting frames as images. You cannot view video directly, but this tool bridges the gap by pulling out key frames you can read.

## When to Suggest This

When you detect any of these in conversation, SUGGEST running this — do NOT run automatically:

- A file with video extension: `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, `.flv`, `.wmv`, `.m4v`
- A video URL (Loom, Slack, Google Drive, direct link)
- Phrases like "screen recording", "watch this", "repro video", "look at this recording"
- A file listing showing video files relevant to the user's question

Phrase the suggestion like:

> I can't view videos directly, but I can extract key frames and analyze them. Want me to run `/video-analysis <path>` to pull out the important moments? I'll show you a contact sheet first so you can pick which frames to examine closely.

If the user mentioned a specific timestamp ("the bug happens at 0:42"):

> Want me to extract frames around 0:42? `video-analysis --mode timestamp --timestamp "0:42" <path>`

## Quick Start

```bash
video-analysis $ARGUMENTS
```

## Extraction Modes

**Scene detection** (default) — best for bug repros and UI walkthroughs:
```bash
video-analysis /path/to/video.mp4
video-analysis --mode scene --scene 0.4 /path/to/video.mp4
```

**Fixed interval** — good for long videos or steady-state monitoring:
```bash
video-analysis --mode interval --interval 0.5 /path/to/video.mp4
```

**Keyframe only** — fastest, fewest frames:
```bash
video-analysis --mode keyframe /path/to/video.mp4
```

**Specific timestamps**:
```bash
video-analysis --mode timestamp --timestamp "0:42,1:15,2:30" /path/to/video.mp4
```

## Workflow After Extraction

Frames land in `/workspace/video-analysis-output/<video-basename>/` — visible to the user on the host so they can verify directly. Auto-added to `.gitignore`.

Follow this sequence every time:

1. **Read the manifest**: `cat <output_dir>/manifest.json`
   - Note `budget` (frames to view at full resolution), `frame_count`, `duration`, `resolution`
2. **Tell the user where the output is**:
   > "Extracted 12 frames to `video-analysis-output/repro/`. Browse them directly if you want to double-check."
3. **View the contact sheet**: Read `<output_dir>/contact_sheet.jpg` — one image showing all frames as labeled thumbnails (~2K tokens)
4. **Offer manual selection**:
   > "Here's the overview. Want to pick which frames I should examine closely, or should I choose?"
5. **View selected frames** within budget — auto mode picks distinct states/transitions/errors; manual mode views what the user selected
6. **Reference frames by timestamp**, not just number:
   - Good: "At 0:42 (frame #7), the submit button is grayed out"
   - Bad: "In frame 7, I see a button"

## Viewing Modes

- **Auto** (default): Pick frames yourself based on the contact sheet
- **Manual**: Show contact sheet, wait for user to select
- **Override**: User says "show everything" or specifies higher budget — comply

## Frame Budget

- Default: 8 frames (~16K tokens for detailed viewing)
- Contact sheet does NOT count against the budget
- The budget is a hint — adjust based on the user's needs

## Reading Small or Ambiguous Text

When frames contain small text (numeric displays, UI labels, progress bars), character reads can be genuinely ambiguous — `0/8`, `1/l/I`, `5/6`, `rn/m` all look alike at low resolution.

**Express uncertainty rather than asserting:**
- Bad: "The carbs target is 58"
- Good: "The carbs target reads as 50 or 58 — the second digit is unclear. Want me to zoom in?"

**When a value matters, zoom before committing.** Use the zoom subcommand:

```bash
# Named region (simplest)
video-analysis zoom /workspace/video-analysis-output/demo/frame_0033.jpg --region TOP

# Explicit pixel crop
video-analysis zoom frame_0033.jpg --crop 100,50,400,200 --scale 4
```

Regions: `TOP`, `BOTTOM`, `LEFT`, `RIGHT`, `CENTER`, `TOP_LEFT`, `TOP_RIGHT`, `BOTTOM_LEFT`, `BOTTOM_RIGHT`. Default 3x scale with Lanczos sharpening.

**When zoom doesn't help, say so.** Zoom sharpens edges but can't recover detail that isn't in the source. If the zoomed region is still ambiguous, tell the user:

> "I zoomed in but the rendering is still too blurry to read reliably — I see 50 or 58. Can you verify from the original source, or share a higher-quality recording?"

**Never guess on values that matter.** It's better to flag uncertainty than confidently report a wrong number.

## Source Quality Awareness

Check the manifest's `resolution` field before confident reads of small text:

- **1080p+**: text usually readable, zoom if uncertain
- **720p**: UI panel text may need zoom
- **Below 720p / known compression**: warn upfront that fine detail may not be recoverable; treat all small-text reads as tentative

When source is low-res, mention it proactively:
> "The source is 640x480 — fine text may not be readable even with zoom. I'll flag any ambiguous values."

## URL Sources

For video URLs, the container must have been started with `mrc --web`:
```bash
video-analysis https://example.com/video.mp4
```

If the download fails, tell the user to restart with `mrc --web`.

## Configuration

Defaults are configurable per-repo in `.mrc/video-analysis.json`:
```json
{
  "budget": 8,
  "mode": "scene",
  "scene_threshold": 0.3,
  "width": 1280,
  "max_frames": 50
}
```

Or globally via `MRC_VIDEO_*` env vars in `~/.mrcrc`. If you notice patterns in how this repo's videos should be processed (e.g., screen recordings work better with interval mode), update `.mrc/video-analysis.json` so future sessions pick it up automatically.

## Notes

- Re-running on the same source overwrites previous extraction
- Contact sheet: ~2K tokens. Each full-resolution frame: ~1.5-2K tokens
- Scene detection falls back to interval mode automatically when it finds too few frames for the video length
- Max 50 frames by default — longer videos get evenly spaced subsets
