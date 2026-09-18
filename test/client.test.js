/** 서버 없이 계약을 지키는지 본다 — 자리 맞추기, 화자, 오류 가르기, 자막. */

import assert from "node:assert/strict";
import test from "node:test";
import { Ambiguous, Mora, MoraError, NotAligned, toLrc, toSrt, toVtt } from "../dist/index.js";

const TEXT = "새빨간 노을에\n금방이면 사라질";

/**
 * 서버가 실제로 내는 꼴. `spans` 는 **시각이 붙은 토큰만** 담는다 — 여기서는 「노을에」가 빠졌다.
 * 그래서 배열 자리(0,1,2)와 토큰 번호(0,2,3)가 어긋난다. 이 어긋남이 화자를 엉뚱한 낱말에
 * 붙이던 버그의 원인이었다.
 */
const PAYLOAD = {
  tier: "word",
  confidence: 0.97,
  tokenizer: "unilab-v2",
  offset_unit: "codepoint",
  alignment_id: 421,
  lines: [
    [0, 7, 1000, 2000],
    [8, 16, 2500, 4000],
  ],
  spans: [
    [0, 3, 1000, 1400, 0],
    [8, 12, 2500, 3200, 0],
    [13, 16, 3200, 4000, 1],
  ],
  speaker_turns: [
    [0, 1000, 2000, 0.9],
    [1, 2500, 4000, 0.8],
  ],
  word_speakers: [
    [0, 0, 0.9],
    [2, 1, 0.8],
    [3, 1, 0.8],
  ],
  line_speakers: [
    [0, 0, 0.9],
    [1, 1, 0.8],
  ],
};

/** 같은 글을 서버와 같은 방식으로 자른 것. 「노을에」가 1번이라 뒤가 하나씩 밀린다. */
const TOKENS = {
  tokens: [
    [0, 3, 0],
    [4, 7, 0],
    [8, 12, 1],
    [13, 16, 1],
  ],
};

/**
 * 서버 대신 미리 짜 둔 응답을 돌려준다. 어느 경로를 물었는지도 적어 둔다.
 *
 * @param {Record<string, unknown>} byPath - 경로 조각마다 돌려줄 것.
 * @param {number} status - HTTP 상태.
 * @returns {{ fetch: Function, asked: string[] }} 가짜 fetch 와 물어본 경로들.
 */
function serve(byPath, status = 200) {
  const asked = [];
  const fake = async (url) => {
    const path = String(url).replace("https://mora.junx.dev", "");
    asked.push(path);
    const key = Object.keys(byPath).find((one) => path.startsWith(one)) ?? "";
    const payload = byPath[key] ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetch: fake, asked };
}

/**
 * 가짜 서버를 세우고 한 번 부른다.
 *
 * @param {object} fake - `serve` 가 만든 것.
 * @param {Function} run - 부를 것.
 * @returns {Promise<unknown>} 부른 결과.
 */
async function withServer(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("곡을 가리키지 못하면 부르기 전에 막는다", async () => {
  // 네트워크를 타기 전에 막혀야 한다. 서버까지 갔다 오면 400 을 받지만, 그때는 이미 왕복 한 번을
  // 버린 뒤이고 오류 문구도 부르는 쪽의 실수를 가리키지 않는다.
  const fake = serve({});
  await withServer(fake, async () => {
    await assert.rejects(() => new Mora().align("x", { artist: "a", title: "b" }), TypeError);
    await assert.rejects(() => new Mora().align("x", {}), TypeError);
  });
  assert.deepEqual(fake.asked, [], "부르지 않아야 한다");
});

test("식별자는 배타적이고 순서가 있다", async () => {
  // 서버가 ISRC 를 보면 나머지를 아예 안 읽는다. 여기서도 하나만 실어야 한다.
  let sent;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify(PAYLOAD) };
  };
  try {
    await new Mora().align(TEXT, { isrc: "KRA401200001" }, { speakers: false });
    assert.deepEqual(Object.keys(sent).sort(), ["isrc", "text"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("낱말은 잘려 온 글자를 그대로 들고 있다", async () => {
  const fake = serve({ "/v1/align": PAYLOAD });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }, { speakers: false }));
  assert.deepEqual(got.words.map((one) => one.text), ["새빨간", "금방이면", "사라질"]);
  assert.deepEqual(got.words.map((one) => one.startMs), [1000, 2500, 3200]);
  assert.equal(got.words[2].interpolated, true);
  assert.equal(got.words[0].interpolated, false);
});

test("토큰을 안 받아 오면 화자를 비워 둔다", async () => {
  // 잘못 붙이느니 비워 둔다. 예전에는 배열 자리를 번호로 써서 엉뚱한 낱말에 붙었다.
  const fake = serve({ "/v1/align": PAYLOAD });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }, { speakers: false }));
  assert.deepEqual(got.words.map((one) => one.speaker), [undefined, undefined, undefined]);
  assert.deepEqual(got.lines.map((one) => one.speaker), [undefined, undefined]);
});

test("토큰을 받아 오면 화자가 제 낱말에 붙는다", async () => {
  const fake = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }));
  // 토큰 번호 0·2·3 이 각각 화자 0·1·1 이다. 배열 자리로 붙였다면 0·1·undefined 가 됐다.
  assert.deepEqual(got.words.map((one) => one.token), [0, 2, 3]);
  assert.deepEqual(got.words.map((one) => one.speaker), [0, 1, 1]);
  assert.deepEqual(got.lines.map((one) => one.index), [0, 1]);
  assert.deepEqual(got.lines.map((one) => one.speaker), [0, 1]);
});

test("auto 는 화자 표가 올 때만 토큰을 더 묻는다", async () => {
  const loud = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  await withServer(loud, () => new Mora().align(TEXT, { isrc: "X" }));
  assert.ok(loud.asked.some((one) => one.startsWith("/v1/tokenize")));

  const quiet = serve({
    "/v1/align": { ...PAYLOAD, word_speakers: [], line_speakers: [] },
    "/v1/tokenize": TOKENS,
  });
  await withServer(quiet, () => new Mora().align(TEXT, { isrc: "X" }));
  assert.ok(!quiet.asked.some((one) => one.startsWith("/v1/tokenize")), "한 사람이 부른 곡은 요청이 안 는다");
});

test("줄에 속한 낱말만 그 줄에 담긴다", async () => {
  const fake = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }));
  assert.deepEqual(got.lines[0].words.map((one) => one.text), ["새빨간"]);
  assert.deepEqual(got.lines[1].words.map((one) => one.text), ["금방이면", "사라질"]);
});

test("지금 무엇이 불리는지 묻는다", async () => {
  const fake = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }));
  assert.equal(got.lineAt(1500).text, "새빨간 노을에");
  assert.equal(got.wordAt(1500), undefined, "낱말은 1400 에 끝났다");
  assert.equal(got.wordAt(1200).text, "새빨간");
  assert.equal(got.lineAt(2200), undefined, "줄 사이는 비어 있다");
  assert.equal(got.durationMs, 4000);
  assert.equal(got.hasWordTiming, true);
});

test("화자 토막이 그대로 온다", async () => {
  const fake = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }));
  assert.equal(got.speakers.length, 2);
  assert.equal(got.speakers[1].speakerId, 1);
  assert.equal(got.speakers[1].confidence, 0.8);
});

test("오류는 부르는 쪽이 할 일에 따라 갈린다", async () => {
  await withServer(serve({ "": { error: "NOT_FOUND" } }, 404), async () => {
    await assert.rejects(() => new Mora().align("x", { isrc: "NONE" }), (error) => {
      assert.ok(error instanceof NotAligned);
      assert.equal(error.code, "NOT_FOUND");
      return true;
    });
  });

  // tier none 은 곡은 찾았으나 가사가 달라 붙이지 못한 것이다. 부르는 쪽에서는 같은 뜻이다.
  await withServer(serve({ "": { tier: "none", confidence: 0, lines: [], spans: [] } }), async () => {
    await assert.rejects(() => new Mora().align("x", { isrc: "SOME" }), NotAligned);
  });

  // 이름이 겹치는 것은 ISRC 로 다시 물으면 되므로 고장과 다르다.
  await withServer(serve({ "": { error: "AMBIGUOUS_RECORDING" } }, 409), async () => {
    await assert.rejects(() => new Mora().align("x", { artist: "a", title: "b", durationMs: 1000 }), (error) => {
      assert.ok(error instanceof Ambiguous);
      return true;
    });
  });

  await withServer(serve({ "": { error: "INTERNAL" } }, 500), async () => {
    await assert.rejects(() => new Mora().align("x", { isrc: "SOME" }), (error) => {
      assert.ok(error instanceof MoraError);
      assert.ok(!(error instanceof NotAligned));
      assert.ok(!(error instanceof Ambiguous));
      return true;
    });
  });
});

test("LRC 는 낱말 시각까지 적는다", async () => {
  const fake = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }));
  assert.equal(toLrc(got, { enhanced: false }).split("\n")[0], "[00:01.00]새빨간 노을에");
  assert.equal(toLrc(got).split("\n")[0], "[00:01.00]<00:01.00>새빨간");
});

test("SRT 와 WebVTT 의 시각 표기", async () => {
  const fake = serve({ "/v1/align": PAYLOAD, "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }));
  const srt = toSrt(got).split("\n");
  assert.equal(srt[0], "1");
  assert.equal(srt[1], "00:00:01,000 --> 00:00:02,000");
  assert.equal(srt[2], "새빨간 노을에");
  const vtt = toVtt(got).split("\n");
  assert.equal(vtt[0], "WEBVTT");
  assert.equal(vtt[2], "00:00:01.000 --> 00:00:02.000");
});

test("한 시간이 넘어도 LRC 는 분을 계속 센다", async () => {
  // LRC 에는 시(hour) 칸이 없다. 61분은 61:00 이지 01:00 이 아니다.
  const long = { ...PAYLOAD, lines: [[0, 7, 3_660_000, 3_665_000]], spans: [] };
  const fake = serve({ "/v1/align": long });
  const got = await withServer(fake, () => new Mora().align(TEXT, { isrc: "X" }, { speakers: false }));
  assert.ok(toLrc(got).startsWith("[61:00.00]"));
});

test("tokenize 는 글자까지 붙여 준다", async () => {
  const fake = serve({ "/v1/tokenize": TOKENS });
  const got = await withServer(fake, () => new Mora().tokenize(TEXT));
  assert.deepEqual(got.map((one) => one.text), ["새빨간", "노을에", "금방이면", "사라질"]);
  assert.deepEqual(got.map((one) => one.line), [0, 0, 1, 1]);
});
