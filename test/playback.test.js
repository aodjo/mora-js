/** 재생 도우미 — 앞으로 흐를 때도 뒤로 감을 때도 같은 답을 내야 한다. */

import assert from "node:assert/strict";
import test from "node:test";
import { Alignment, Playhead } from "../dist/index.js";

/**
 * 손으로 지은 작은 정렬.
 *
 * @returns {Alignment} 세 줄과 그 안의 낱말들.
 */
function song() {
  const words = [
    { text: "새빨간", startMs: 1000, endMs: 1400, interpolated: false, start: 0, end: 3, token: 0 },
    { text: "노을에", startMs: 1400, endMs: 2000, interpolated: false, start: 4, end: 7, token: 1 },
    { text: "금방이면", startMs: 2500, endMs: 3200, interpolated: false, start: 8, end: 12, token: 2 },
    { text: "사라질", startMs: 3200, endMs: 4000, interpolated: false, start: 13, end: 16, token: 3 },
    { text: "오", startMs: 6000, endMs: 7500, interpolated: false, start: 17, end: 18, token: 4 },
  ];
  const lines = [
    { text: "새빨간 노을에", startMs: 1000, endMs: 2000, words: words.slice(0, 2), start: 0, end: 7, index: 0 },
    { text: "금방이면 사라질", startMs: 2500, endMs: 4000, words: words.slice(2, 4), start: 8, end: 16, index: 1 },
    { text: "오", startMs: 6000, endMs: 7500, words: words.slice(4), start: 17, end: 18, index: 2 },
  ];
  return new Alignment("word", 1, "unilab-v2", 1, lines, words, [], "");
}

test("노래를 따라 앞으로 간다", () => {
  const head = new Playhead(song());
  assert.equal(head.at(500).line, undefined, "앞 간주");
  assert.equal(head.at(1200).line.text, "새빨간 노을에");
  assert.equal(head.at(1200).word.text, "새빨간");
  assert.equal(head.at(1600).word.text, "노을에");
  assert.equal(head.at(2200).line, undefined, "줄 사이");
  assert.equal(head.at(3000).line.text, "금방이면 사라질");
  assert.equal(head.at(9000).line, undefined, "끝난 뒤");
});

test("뒤로 감아도 같은 답을 낸다", () => {
  // 커서를 두고 따라가므로, 뒤로 감았을 때 앞선 자리에 갇히면 안 된다.
  const head = new Playhead(song());
  head.at(7000);
  assert.equal(head.at(1200).line.text, "새빨간 노을에");
  assert.equal(head.at(3000).line.text, "금방이면 사라질");
});

test("진행도는 줄의 처음에서 끝까지 흐른다", () => {
  const head = new Playhead(song());
  assert.equal(head.at(1000).progress, 0);
  assert.ok(Math.abs(head.at(1500).progress - 0.5) < 1e-9);
  assert.ok(head.at(1999).progress > 0.99);
});

test("다음 줄까지 얼마나 남았는지 말한다", () => {
  const head = new Playhead(song());
  assert.equal(head.at(2200).untilNextMs, 300, "다음 줄이 2500 에 시작한다");
  assert.equal(head.at(1000).untilNextMs, 1500);
  assert.equal(head.at(7400).untilNextMs, undefined, "뒤에 줄이 없다");
});

test("줄 번호도 함께 준다", () => {
  const head = new Playhead(song());
  assert.equal(head.at(1200).lineNumber, 0);
  assert.equal(head.at(3000).lineNumber, 1);
  assert.equal(head.at(2200).lineNumber, undefined, "줄이 없으면 번호도 없다");
});

test("빈 곡에서도 깨지지 않는다", () => {
  const now = new Playhead(new Alignment("none", 0, "", 0, [], [], [], "")).at(1234);
  assert.equal(now.line, undefined);
  assert.equal(now.word, undefined);
  assert.equal(now.progress, 0);
  assert.equal(now.untilNextMs, undefined);
});
