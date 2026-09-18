/**
 * 코드포인트 오프셋 — 이 라이브러리에만 있는 함정.
 *
 * 서버는 오프셋을 코드포인트로 센다. 자바스크립트 문자열은 UTF-16 코드유닛으로 세므로, 보조평면
 * 글자(이모지, 일부 한자)가 하나라도 섞이면 그 뒤의 **모든** 자리가 밀린다. 파이썬 문자열은
 * 코드포인트로 세니 그쪽에는 이 문제가 없다.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Mora } from "../dist/index.js";

/**
 * 서버 대신 미리 짜 둔 응답을 돌려준다.
 *
 * @param {object} payload - 돌려줄 것.
 * @returns {Function} 가짜 fetch.
 */
function serve(payload) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
}

/**
 * 가짜 서버를 세우고 한 번 부른다.
 *
 * @param {object} payload - 서버가 줄 것.
 * @param {Function} run - 부를 것.
 * @returns {Promise<unknown>} 부른 결과.
 */
async function withServer(payload, run) {
  const original = globalThis.fetch;
  globalThis.fetch = serve(payload);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("보조평면 글자가 섞여도 오프셋이 밀리지 않는다", async () => {
  // 서버는 코드포인트로 센다: 사0 랑1 ␣2 🔥3 ␣4 해5 — 모두 여섯 자다.
  // 자바스크립트에서 🔥 는 두 칸을 차지하므로 그대로 slice 하면 그 뒤가 한 칸씩 밀린다.
  const text = "사랑 🔥 해";
  assert.equal([...text].length, 6, "코드포인트로는 여섯");
  assert.equal(text.length, 7, "UTF-16 으로는 일곱");

  const got = await withServer(
    {
      tier: "word",
      confidence: 1,
      tokenizer: "unilab-v2",
      alignment_id: 1,
      lines: [[0, 6, 0, 3000]],
      spans: [
        [0, 2, 0, 1000, 0],
        [3, 4, 1000, 2000, 0],
        [5, 6, 2000, 3000, 0],
      ],
      word_speakers: [],
      line_speakers: [],
    },
    () => new Mora().align(text, { isrc: "TEST00000000" }),
  );

  assert.deepEqual(got.words.map((one) => one.text), ["사랑", "🔥", "해"]);
  assert.equal(got.lines[0].text, text);
  // 순진하게 잘랐다면 이렇게 어긋난다 — 이 시험이 지키는 것이 그 차이다.
  assert.notEqual(text.slice(3, 4), "🔥", "그대로 자르면 서러게이트 반쪽이 나온다");
});

test("이모지 뒤의 줄까지 통째로 밀리지 않는다", async () => {
  // 첫 줄에 이모지가 있으면 그 뒤 줄들이 전부 밀린다. 한 곡에서 가장 흔한 꼴이다.
  const text = "🎵 시작\n둘째 줄";
  // 코드포인트: 🎵0 ␣1 시2 작3 \n4 둘5 째6 ␣7 줄8
  const got = await withServer(
    {
      tier: "word",
      confidence: 1,
      tokenizer: "unilab-v2",
      alignment_id: 2,
      lines: [
        [0, 4, 0, 1000],
        [5, 9, 2000, 3000],
      ],
      spans: [
        [0, 1, 0, 300, 0],
        [2, 4, 300, 1000, 0],
        [5, 7, 2000, 2500, 0],
        [8, 9, 2500, 3000, 0],
      ],
      word_speakers: [],
      line_speakers: [],
    },
    () => new Mora().align(text, { isrc: "TEST00000000" }),
  );

  assert.equal(got.lines[0].text, "🎵 시작");
  assert.equal(got.lines[1].text, "둘째 줄");
  assert.deepEqual(got.words.map((one) => one.text), ["🎵", "시작", "둘째", "줄"]);
});

test("tokenize 도 같은 자리로 자른다", async () => {
  const text = "사랑 🔥 해";
  const got = await withServer(
    { tokens: [[0, 2, 0], [3, 4, 0], [5, 6, 0]] },
    () => new Mora().tokenize(text),
  );
  assert.deepEqual(got.map((one) => one.text), ["사랑", "🔥", "해"]);
});

test("이모지가 없으면 자리가 그대로다", async () => {
  // 흔한 경우에 쓸데없는 일을 하지 않는지 — 결과가 같아야 한다.
  const text = "첫 줄\n둘째 줄";
  const got = await withServer(
    {
      tier: "word",
      confidence: 0.9,
      tokenizer: "unilab-v2",
      alignment_id: 3,
      lines: [
        [0, 3, 0, 1000],
        [4, 8, 2000, 3000],
      ],
      spans: [
        [0, 1, 0, 400, 0],
        [2, 3, 400, 1000, 0],
        [4, 6, 2000, 2500, 1],
        [7, 8, 2500, 3000, 0],
      ],
      word_speakers: [],
      line_speakers: [],
    },
    () => new Mora().align(text, { artist: "a", title: "b", durationMs: 3000 }),
  );
  assert.deepEqual(got.lines[0].words.map((one) => one.text), ["첫", "줄"]);
  assert.deepEqual(got.lines[1].words.map((one) => one.text), ["둘째", "줄"]);
  assert.equal(got.words[2].interpolated, true);
});
