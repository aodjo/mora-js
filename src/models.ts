/**
 * 정렬 결과를 담는 자료들.
 *
 * 서버는 숫자 배열만 돌려준다 — 오프셋과 밀리초. 글자는 부르는 쪽이 보낸 가사에 그대로 있으므로
 * 여기서 잘라 붙인다. 오프셋은 **코드포인트** 단위인데 자바스크립트 문자열은 UTF-16 코드유닛으로
 * 세므로, 자르기 전에 반드시 자리를 옮겨야 한다(`client.ts` 의 `codepointIndex`).
 */

/** 얼마나 잘게 붙었나. `word` 는 낱말마다, `line` 은 줄까지만, `none` 은 못 붙인 것. */
export type Tier = "word" | "word-approx" | "line" | "none";

/**
 * 서버가 직접 적어 주는 형식.
 *
 * 이 글들은 **가사 글자를 담지 않는다** — 큐 안에 코드포인트 범위 숫자가 들어간다. 사람이 읽을
 * 자막이 필요하면 `toLrc()` 쪽을 쓴다.
 */
export type Format = "spans" | "lrc-a2" | "lyricsfile" | "ttml" | "webvtt";

/** 한 낱말과 그것이 불린 구간. */
export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  /** 들어서 잰 것이 아니라 앞뒤 사이를 나눠 짐작한 자리. */
  interpolated: boolean;
  /** 제출한 가사에서의 코드포인트 오프셋. */
  start: number;
  end: number;
  /** 정렬기가 센 토큰 번호. 화자를 붙일 때 쓴다. 토큰을 안 받아 왔으면 undefined. */
  token?: number;
  /** 누가 불렀나. 화자를 안 받아 왔거나 한 사람이 부른 곡이면 undefined. */
  speaker?: number;
}

/** 한 줄과 그것이 불린 구간. */
export interface Line {
  text: string;
  startMs: number;
  endMs: number;
  words: Word[];
  start: number;
  end: number;
  /** 가사에서 몇 번째 줄인가(빈 줄과 `[Verse]` 같은 머리말은 세지 않는다). */
  index?: number;
  speaker?: number;
}

/** 한 사람이 이어서 부른 구간. */
export interface Speaker {
  speakerId: number;
  startMs: number;
  endMs: number;
  confidence: number;
}

/** `/v1/tokenize` 가 돌려주는 낱말 한 조각. */
export interface Token {
  text: string;
  start: number;
  end: number;
  line: number;
}

/** 시각이 있는 것 — 낱말이든 줄이든 `at`/`end` 로 견줄 수 있다. */
interface Timed {
  startMs: number;
  endMs: number;
}

/**
 * Find the item being sung at a moment, if any.
 *
 * 항목은 시작 시각 순이고 겹치지 않는다. 그러니 시작 시각만 이진 탐색해 바로 앞의 것을 찾고,
 * 그것이 아직 안 끝났는지만 보면 된다. 간주에는 아무것도 없으므로 undefined 가 정상이다.
 *
 * @param {T[]} items - Words or lines in time order.
 * @param {number} positionMs - The moment to ask about.
 * @returns {T | undefined} What is being sung then.
 */
function at<T extends Timed>(items: T[], positionMs: number): T | undefined {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.startMs <= positionMs) low = middle + 1;
    else high = middle;
  }
  const found = items[low - 1];
  return found !== undefined && positionMs < found.endMs ? found : undefined;
}

/** 가사 전체에 시각이 붙은 결과. */
export class Alignment {
  constructor(
    readonly tier: Tier,
    /** 제출한 가사가 맞춰 둔 가사와 얼마나 같은가. 1.0 이면 글자까지 같다. */
    readonly confidence: number,
    readonly tokenizer: string,
    readonly alignmentId: number,
    readonly lines: Line[],
    readonly words: Word[],
    readonly speakers: Speaker[],
    readonly text: string,
  ) {}

  /** @returns {boolean} 낱말마다 시각이 붙었는가. */
  get hasWordTiming(): boolean {
    return this.tier === "word" || this.tier === "word-approx";
  }

  /** @returns {number} 마지막 줄이 끝나는 시각(ms). */
  get durationMs(): number {
    return this.lines.length === 0 ? 0 : this.lines[this.lines.length - 1]!.endMs;
  }

  /**
   * 그 순간 불리고 있는 줄.
   *
   * @param {number} positionMs - 곡의 어느 순간(ms).
   * @returns {Line | undefined} 그때 불리는 줄. 간주면 undefined.
   */
  lineAt(positionMs: number): Line | undefined {
    return at(this.lines, positionMs);
  }

  /**
   * 그 순간 불리고 있는 낱말.
   *
   * @param {number} positionMs - 곡의 어느 순간(ms).
   * @returns {Word | undefined} 그때 불리는 낱말. 없으면 undefined.
   */
  wordAt(positionMs: number): Word | undefined {
    return at(this.words, positionMs);
  }

  /** @returns {Iterator<Line>} 줄을 차례로. */
  [Symbol.iterator](): Iterator<Line> {
    return this.lines[Symbol.iterator]();
  }
}
