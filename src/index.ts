/**
 * Mora — 노래의 어느 순간에 어느 낱말이 불리는지.
 *
 * 가진 가사를 그대로 보내면 시각이 붙어 돌아온다. 가사 표기를 서버에 맞출 필요는 없다 — 서버가
 * 지문으로 견주어 제 자리에 얹는다.
 *
 * @example
 *   import { Mora } from "mora-lyrics";
 *
 *   const mora = new Mora();
 *   const got = await mora.align(lyrics, { artist: "검정치마", title: "EVERYTHING", durationMs: 293000 });
 *   console.log(got.tier, got.confidence);
 *   for (const line of got.lines) console.log(line.startMs, line.text);
 */

export {
  Ambiguous,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  Mora,
  MoraError,
  NotAligned,
  VERSION,
  type AlignOptions,
  type Options,
  type Recording,
} from "./client.js";
export { toLrc, toSrt, toVtt } from "./export.js";
export { Alignment, type Format, type Line, type Speaker, type Tier, type Token, type Word } from "./models.js";
export { Playhead, type Moment } from "./playback.js";
