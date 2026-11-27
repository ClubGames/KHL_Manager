# The club's match sounds

Supplied by the project owner (uploaded to this folder in commit 510fd71). Their source and licence are the owner's
to record here — **to be filled in** before a release that needs attribution.

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
| crowd_whistle.mp3 | the home fans whistling while their team is short-handed and the opponent is in its zone |

Should a file not decode on a device, the synthesized sound plays in its place.
