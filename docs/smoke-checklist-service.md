# Service smoke checklist

## Detector process (Task 7)

### Step 5: live chat check

`sleep 20 | python -m hl_detector --channel gaules --config ../config.example.json` (stdin held open;
with `< NUL` the process sees EOF and exits at once, by design). Output over 20 s: `status chat=connected`
followed by `heartbeat` every 5 s. Result: OK (live channel: gaules).

### Step 6: early load measurement (spec section 12, item 1)

Method: throwaway script `spike-load.mjs` (not committed) runs, per copy,
`streamlink --stdout twitch.tv/<ch> best | ffmpeg -map 0:a:0 -ac 1 -ar 16000 -f s16le pipe:1` and wraps the output
into type-0 frames for `python -m hl_detector` (real Silero VAD, real Twitch IRC). Channels live at the time:
gaules, lirik, eslcs. Window: 30 s warm-up, then 120 s measured (shortened from the planned 5 minutes).
Machine: 8 logical cores, Windows 10. CPU is process-tree CPU time over the window; "core" = % of one core,
"machine" = % of the whole 8-core machine. Memory is working set at the end of the window.

| Copies | detector CPU (core / machine) | ffmpeg CPU | streamlink CPU | Total CPU (core / machine) | Memory (detector + ffmpeg + streamlink) |
|---|---|---|---|---|---|
| 1 | 0.7 % / 0.1 % | 0.2 % | 0.6 % | 1.5 % / 0.2 % | 70 + 22 + 60 MB |
| 3 | 2.1 % / 0.3 % | 0.8 % | 2.1 % | 5.0 % / 0.6 % | 210 + 65 + 177 MB |
| 5 | 3.7 % / 0.5 % | 1.4 % | 3.7 % | 8.8 % / 1.1 % | 350 + 108 + 299 MB |

Conclusion: 5 copies use about 1 % of the machine, far below the 60 % threshold; the process-per-stream
design is not in question. The detector emitted `signals` once per second per copy and `status connected`
for every copy; no events fired (no loud voice spikes during the windows).
