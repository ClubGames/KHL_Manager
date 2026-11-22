import type { Lineup, PlayerStats, TeamRecord, UserSettings } from '../types';

export const emptyStats = (): PlayerStats => ({
  gp: 0, goals: 0, assists: 0, plusMinus: 0, pim: 0, shots: 0, wins: 0, losses: 0, otl: 0, shutouts: 0, saves: 0, shotsAgainst: 0, minutes: 0,
});

export const emptyRecord = (): TeamRecord => ({
  gp: 0, w: 0, otw: 0, sow: 0, otl: 0, sol: 0, l: 0, gf: 0, ga: 0, points: 0, streak: 0, streakType: null, last: [],
});

export const emptyLineup = (): Lineup => ({
  F: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
  D: [[null, null], [null, null], [null, null]],
  pp1: [], pp2: [], pk1: [], pk2: [],
  starterG: null,
  backupG: null,
});

export const defaultSettings: UserSettings = { goalReplay3d: true };
