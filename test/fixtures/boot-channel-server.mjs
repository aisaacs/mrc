// Boots the REAL container/mrc-channel-server.js (SDK stubbed via `--import register-sdk-stub`) so it actually
// CONNECTS to a test daemon, registers, and surfaces delivered/redelivered frames through the real onFrame →
// createInboundDedup → pushIn → renderFrame path. The capture stub prints one `SURFACED\t<content>` line per
// pushIn to stdout, which the live integration test parses. The server's own heartbeat keeps this process alive
// (a faithful stand-in for a real container); the test kills + respawns it to model a container PROCESS restart
// (fresh dedup). Config comes from env (MRC_ROOM_PORT/HOST, MRC_SESSION_ID, MRC_MEMBER_HANDLE, MRC_ROOM_SECRET…).
process.env.MRC_CAPTURE_SURFACED = '1'
await import(new URL('../../container/mrc-channel-server.js', import.meta.url).href)
