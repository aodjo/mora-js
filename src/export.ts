/**
 * 시각이 붙은 가사를 자막 글로 적는다.
 *
 * 서버도 `lrc-a2` · `webvtt` · `ttml` 을 내주지만 **그 글에는 가사 글자가 없다** — 큐 안에 들어가는
 * 것은 코드포인트 범위 숫자다. 재생기에 띄우려면 결국 글자가 필요하므로 여기서 조립한다.
 */

import type { Alignment } from "./models.js";

/**
 * Write a moment the way LRC does: `mm:ss.xx`.
 *
 * 한 시간이 넘는 녹음에서도 분이 60 을 넘어 이어진다 — LRC 에는 시(hour) 칸이 없다.
 *
 * @param {number} ms - The moment.
 * @returns {string} `mm:ss.xx`.
 */
function lrcTime(ms: number): string {
  const now = Math.max(0, Math.round(ms));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(now / 60000))}:${pad(Math.floor((now % 60000) / 1000))}.${pad(Math.floor((now % 1000) / 10))}`;
}

/**
 * Write a moment the way SRT and WebVTT do: `hh:mm:ss,mmm` or `hh:mm:ss.mmm`.
 *
 * @param {number} ms - The moment.
 * @param {boolean} comma - True for SRT's comma, false for WebVTT's dot.
 * @returns {string} The stamp.
 */
function clock(ms: number, comma: boolean): string {
  const now = Math.max(0, Math.round(ms));
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const mark = comma ? "," : ".";
  return `${pad(Math.floor(now / 3600000))}:${pad(Math.floor((now % 3600000) / 60000))}:${pad(
    Math.floor((now % 60000) / 1000),
  )}${mark}${pad(now % 1000, 3)}`;
}

/**
 * LRC 로 적는다.
 *
 * `enhanced` 면 낱말마다 `<mm:ss.xx>` 를 앞에 붙인다(A2 확장) — 노래방처럼 낱말 단위로 칠할 수
 * 있다. 낱말 시각이 없는 정렬에서는 그 표시가 없으므로 줄만 적는다.
 *
 * @param {Alignment} alignment - 시각이 붙은 가사.
 * @param {object} options - `enhanced` 면 낱말 시각도 적는다(기본 true).
 * @returns {string} LRC 글.
 */
export function toLrc(alignment: Alignment, options: { enhanced?: boolean } = {}): string {
  const enhanced = options.enhanced ?? true;
  const out = alignment.lines.map((line) => {
    const body = enhanced && line.words.length > 0
      ? line.words.map((one) => `<${lrcTime(one.startMs)}>${one.text}`).join("")
      : line.text;
    return `[${lrcTime(line.startMs)}]${body}`;
  });
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/**
 * SRT 자막으로 적는다.
 *
 * @param {Alignment} alignment - 시각이 붙은 가사.
 * @returns {string} SRT 글.
 */
export function toSrt(alignment: Alignment): string {
  const out: string[] = [];
  alignment.lines.forEach((line, position) => {
    out.push(String(position + 1));
    out.push(`${clock(line.startMs, true)} --> ${clock(line.endMs, true)}`);
    out.push(line.text);
    out.push("");
  });
  return out.join("\n");
}

/**
 * WebVTT 로 적는다.
 *
 * `enhanced` 면 낱말마다 `<00:00:12.340>` 를 끼워 넣는다 — 브라우저가 그것으로 지금 부르는 낱말에
 * `::cue(...)` 를 걸 수 있다.
 *
 * @param {Alignment} alignment - 시각이 붙은 가사.
 * @param {object} options - `enhanced` 면 낱말 시각도 끼운다(기본 false).
 * @returns {string} WebVTT 글.
 */
export function toVtt(alignment: Alignment, options: { enhanced?: boolean } = {}): string {
  const enhanced = options.enhanced ?? false;
  const out: string[] = ["WEBVTT", ""];
  for (const line of alignment.lines) {
    out.push(`${clock(line.startMs, false)} --> ${clock(line.endMs, false)}`);
    out.push(
      enhanced && line.words.length > 0
        ? line.words.map((one) => `<${clock(one.startMs, false)}>${one.text}`).join("")
        : line.text,
    );
    out.push("");
  }
  return out.join("\n");
}
