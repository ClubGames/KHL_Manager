# The club's match sounds

Supplied by the project owner (uploaded to this folder in commit 510fd71). Source: recordings found on the internet
(the owner's answer); **authors and licence unknown**. Before the game is published (a store release, a public
build) each file needs a known licence that allows it — or a replacement under CC0 / a bought licence.

Edits made in the repository: the embedded cover art and tags removed, silence at the ends trimmed, short fades at
the cut ends, re-encoded to mono MP3 (crowd 24 kHz / 40–48 kbit/s, horn and siren 32 kHz / 64 kbit/s) to keep the app
small. The game sets the levels itself (by RMS) and loops the bed and the whistling with its own crossfades.

| File | Where it plays |
|---|---|
| period_end.mp3 | the end of each period (instead of the synthesized siren) |
| goal_horn.mp3 | a home goal (instead of the synthesized horn) |
| crowd_bed.mp3 | the arena crowd under the whole match (instead of the former CC0 murmur) |
| crowd_joy.mp3 | the fans' joy over the bed: a home goal and a home win loudly; quietly, off to one side, an away goal |
| crowd_boo.mp3 | home arena boos: a home penalty, a goal against, a home loss |
| crowd_whistle.mp3 | the home fans whistling while their team is short-handed, the puck in their zone and the opponent has it |

Should a file not decode on a device, the synthesized sound plays in its place. Leaving the match screen fades every
one of them out (and the organ).

## Menu music and interface clicks

Not files: both are synthesized in the app (`src/components/sound/menuMusic.ts`, `uiClicks.ts`). The menu music is an
original piece written for the game (92 BPM, A minor: a pad, a plucked arpeggio with an echo, bass, soft drums, a bell
melody in the chorus) — no samples, no third-party recordings, nothing added to the download.
