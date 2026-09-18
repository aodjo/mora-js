/**
 * 재생기에 붙이는 도우미.
 *
 * 가사 화면은 1초에 수십 번 「지금 어느 줄인가」를 묻는다. 그때마다 이진 탐색을 새로 하는 것은
 * 틀리지는 않지만 필요가 없다 — 시간은 대개 앞으로만 흐르므로, 저번에 있던 자리에서 한두 칸만
 * 보면 된다. 뒤로 감았을 때만 다시 찾는다.
 */

import type { Alignment, Line, Word } from "./models.js";

/** 그 순간 화면이 알아야 하는 것 전부. */
export interface Moment {
  line?: Line;
  word?: Word;
  /** 지금 줄이 어디까지 왔나(0.0~1.0). 줄이 없으면 0. */
  progress: number;
  /** 다음 줄이 시작하기까지 남은 시간(ms). 다음 줄이 없으면 undefined. */
  untilNextMs?: number;
  /** 지금 줄의 자리. 줄이 없으면 undefined. */
  lineNumber?: number;
}

/** 시각이 있는 것 — 낱말이든 줄이든 커서로 따라갈 수 있다. */
interface Timed {
  startMs: number;
  endMs: number;
}

/**
 * Move a cursor to the last item that starts at or before a moment.
 *
 * 앞으로 흐르면 한 칸씩 나아가고, 뒤로 감았으면 뒤로 물러난다. 한 번에 멀리 건너뛰어도 맞기는
 * 하지만, 그럴 때만 값이 든다 — 보통은 0~1 칸이다.
 *
 * @param {T[]} items - Words or lines in time order.
 * @param {number} spot - Where the cursor was.
 * @param {number} positionMs - The moment now.
 * @returns {number} Where the cursor should be.
 */
function walk<T extends Timed>(items: T[], spot: number, positionMs: number): number {
  if (items.length === 0) return 0;
  let now = Math.min(Math.max(spot, 0), items.length - 1);
  while (now + 1 < items.length && items[now + 1]!.startMs <= positionMs) now += 1;
  while (now > 0 && items[now]!.startMs > positionMs) now -= 1;
  return now;
}

/**
 * 한 곡을 따라가며 지금 불리는 줄과 낱말을 알려 준다.
 *
 * @example
 *   const head = new Playhead(alignment);
 *   const now = head.at(player.currentTime * 1000);
 *   if (now.line) draw(now.line.text, now.progress);
 */
export class Playhead {
  #line = 0;
  #word = 0;

  constructor(readonly alignment: Alignment) {}

  /**
   * 그 순간의 줄·낱말과 진행도.
   *
   * @param {number} positionMs - 재생기가 말하는 지금(ms).
   * @returns {Moment} 그때 화면이 알아야 하는 것.
   */
  at(positionMs: number): Moment {
    const lines = this.alignment.lines;
    const words = this.alignment.words;
    this.#line = walk(lines, this.#line, positionMs);
    this.#word = walk(words, this.#word, positionMs);

    let line = lines[this.#line];
    if (line !== undefined && !(line.startMs <= positionMs && positionMs < line.endMs)) line = undefined;
    let word = words[this.#word];
    if (word !== undefined && !(word.startMs <= positionMs && positionMs < word.endMs)) word = undefined;

    const span = line === undefined ? 0 : line.endMs - line.startMs;
    const progress = line === undefined || span <= 0
      ? 0
      : Math.min(1, Math.max(0, (positionMs - line.startMs) / span));

    let untilNextMs: number | undefined;
    for (let spot = Math.max(0, this.#line); spot < lines.length; spot += 1) {
      if (lines[spot]!.startMs > positionMs) {
        untilNextMs = lines[spot]!.startMs - positionMs;
        break;
      }
    }

    const now: Moment = { progress };
    if (line !== undefined) {
      now.line = line;
      now.lineNumber = this.#line;
    }
    if (word !== undefined) now.word = word;
    if (untilNextMs !== undefined) now.untilNextMs = untilNextMs;
    return now;
  }
}
