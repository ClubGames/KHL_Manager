# Bundled club crests

The following 11 `public/logos/*.png` assets were replaced in November 2026.
All are 160×160 RGBA PNGs, aspect-ratio preserved and centred on transparent
canvases. The other bundled club images are unchanged.

| File | Reference / image source | Selected identity |
| --- | --- | --- |
| `amur.png` | https://hcamur.ru/media/teams/54_490mCG0 | Tiger head, no wordmark |
| `neftekhimik.png` | https://www.hcnh.ru/en/ | Wolf crest, no old lightning wordmark |
| `metallurg-mg.png` | https://www.eliteprospects.com/league/khl/game/640806/2025-12-22-metallurg-magnitogorsk-vs-neftekhimik-nizhnekamsk | Standalone fox, not the old English shield |
| `lokomotiv.png` | https://www.eliteprospects.com/team/191/lokomotiv-yaroslavl | Red Л and locomotive, no circular wordmark |
| `spartak.png` | https://www.eliteprospects.com/team/775/spartak-moskva | Hockey club diamond, not the football crest |
| `dinamo-mn.png` | https://www.eliteprospects.com/team/1678/dinamo-minsk | Cyan Д primary mark |
| `dinamo-msk.png` | https://dynamo.ru/ and Wikimedia image search | Blue Д, without the previous pale outer edging |
| `ska.png` | https://www.eliteprospects.com/team/199/ska-st-petersburg | 2025 star with СКА inside |
| `salavat.png` | https://www.eliteprospects.com/league/khl/game/741180/2025-12-30-salavat-yulaev-ufa-vs-dinamo-minsk | Blue/gold/green triangular crest without the old text bar |
| `sochi.png` | https://hcsochi.ru/ and Wikimedia image search | Leopard head; cropped from horizontal crest + wordmark lockup |
| `torpedo.png` | https://www.eliteprospects.com/league/khl/game/826221/2026-01-26-torpedo-nizhny-novgorod-vs-sibir-novosibirsk | 2025 right-facing deer head, no old circle |

Brand-reference articles:

- SKA, July 2025: https://belarushockey.com/khl/news/2025/07/26/ska-predstavil-novyj-logotip-i-obnovljonnyj-firmennyj-stil/
- Torpedo, August 2025: https://pravda-nn.ru/news/hk-torpedo-smenil-logotip-komandy
- Dinamo Minsk primary Д (the bison is an alternate): https://hcdinamo.by/news/sobytiya/vse-o-rebrendinge-minskogo-dinamo/
- Salavat's simplified triangular crest: https://sport.rambler.ru/other/44779969-salavat-yulaev-sygral-pervyy-match-s-novym-logotipom-kak-ego-pridumali-i-zachem-pomenyali/

## Loading behaviour

Keep `getClubLogoSources` local-first after an explicit roster override. Fixing
the bundled artwork is important: prioritising a remote CDN would merely hide
incorrect offline images, introduce network latency and affect already-correct
clubs. `TeamLogo` still tries the KHL CDN after a local load failure, then falls
back to its generated club-colour shield. Existing saves resolve the same club
IDs and aliases, so no save migration is needed.

Validation: `npx tsx scripts/logos-test.ts` checks PNG headers/dimensions/alpha,
local/CDN source ordering, custom overrides, deduplication and legacy aliases.
Visual checks of the replacement images were made against a dark background.
