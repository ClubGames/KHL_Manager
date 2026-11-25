// Writes the league calendar of a mod (mods/<id>/schedule.json) from the built-in generator.
// Run with: npx tsx scripts/export-schedule.ts [modId=KHL_2627]
// The generator is deterministic (seeded by season, club count and games per club), so the exported calendar is
// exactly the one the game built for this roster before calendars became files. Edit the file freely afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { buildSchedule, scheduleFileText, scheduleToFile } from '../src/game/schedule';

const modId = process.argv[2] || 'KHL_2627';
const dir = `public/mods/${modId}`;
const r = parseRosterText(readFileSync(`${dir}/roster.json`, 'utf8'));
const { days } = buildSchedule(r.teams, r.gamesPerTeam, 1, r.season);
const file = scheduleToFile(days, r.season);
writeFileSync(`${dir}/schedule.json`, scheduleFileText(file), 'utf8');
console.log(`${dir}/schedule.json: сезон ${file.season}, ${file.games.length} матчей, ${file.days} дней`);
