// Fake hl_detector speaking the stdio protocol. Flags:
//   --log <file>        append one line per frame: "0 <length>" for pcm, "1 <json body>" for control frames
//   --pause-ms N        do not read stdin for the first N ms (simulates backpressure)
//   --crash-after N     exit(1) after N frames
//   --no-heartbeat      never print anything unprompted
//   --ignore-stop       ignore the stop frame
//   --chat <state>      print a status line with this chat state at startup
//   --event             print an event line when an epoch frame arrives
//   --event-on-stop     print an event line (without a trailing newline) when the stop frame arrives, then exit
//   --fail <text>       print <text> to stderr and exit(3) at startup
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const logFile = opt('--log');
const crashAfter = opt('--crash-after') ? Number(opt('--crash-after')) : Infinity;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const EVENT = { type: 'event', startMs: 1, endMs: 2, triggerTimeMs: 1, estimatedEventMs: 1, uncertaintyMs: 0, triggers: ['laugh'], confidence: 'normal', scores: { S: 1, C: 1, E: 1, U: 1, A: 1 }, signals: { chatSpike: 1, laughShare: 1, reactionShare: 0, deltaDb: 0 } };

if (opt('--fail')) {
  process.stderr.write(`Traceback (most recent call last):\n${opt('--fail')}\n`, () => process.exit(3));
  await new Promise(() => {});
}

if (!has('--no-heartbeat')) {
  out({ type: 'heartbeat' });
  setInterval(() => out({ type: 'heartbeat' }), 50).unref?.();
}
if (opt('--chat')) out({ type: 'status', chat: opt('--chat') });
process.stdout.write('this is not json\n');

let buf = Buffer.alloc(0);
let frames = 0;
let pcmBytes = 0;
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 5) {
    const kind = buf[0];
    const len = buf.readUInt32LE(1);
    if (buf.length < 5 + len) break;
    const body = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);
    frames++;
    let tag = String(len);
    if (kind === 0) pcmBytes += len;
    if (kind === 1) {
      tag = body.toString('utf8');
      const msg = JSON.parse(tag);
      if (msg.type === 'epoch') {
        out({ type: 'signals', tMs: 0, chatSpike: 0, laughShare: 0, messages: pcmBytes, deltaDb: 0, vad: 0, warm: false });
        if (has('--event')) {
          out({ type: 'event', epoch: msg.epoch, startMs: 1, endMs: 2, triggerTimeMs: 1, estimatedEventMs: 1, uncertaintyMs: 0, triggers: ['laugh'], confidence: 'normal', scores: { S: 1, C: 1, E: 1, U: 1, A: 1 }, signals: { chatSpike: 1, laughShare: 1, reactionShare: 0, deltaDb: 0 } });
          out({ type: 'nearmiss', tMs: 5, kind: 'x', missing: [], values: {} });
        }
      }
      if (msg.type === 'stop' && has('--event-on-stop')) {
        process.stdout.write(JSON.stringify({ ...EVENT, epoch: 99 }), () => process.exit(0));
        return;
      }
      if (msg.type === 'stop' && !has('--ignore-stop')) process.exit(0);
    }
    if (logFile) appendFileSync(logFile, `${kind} ${tag}\n`);
    if (frames >= crashAfter) process.exit(1);
  }
});
if (opt('--pause-ms')) {
  process.stdin.pause();
  setTimeout(() => process.stdin.resume(), Number(opt('--pause-ms')));
}
process.stdin.on('end', () => { if (!has('--ignore-stop')) process.exit(0); });
