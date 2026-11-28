/**
 * Pad buttons spent on the app itself (A pressing the broadcast's «Пропустить» while the match holds the pad): the
 * game does not see them until they are let go, so the press that skipped the entrance is not also a pass.
 */
const held = new Set<number>();
export function swallowPadButton(i: number) { held.add(i); }
/** Let go buttons stop being swallowed (`down(i)`: is button i down now). */
export function releasePadButtons(down: (i: number) => boolean) { for (const i of [...held]) if (!down(i)) held.delete(i); }
export function padButtonSwallowed(i: number) { return held.has(i); }
