/** 제공처에서 가사를 가져오는 쪽 — 읽고 고르는 부분과, 가짜 서버를 세운 제공처 한 바퀴. */

import assert from "node:assert/strict";
import test from "node:test";
import { fetchLyrics, playTime, suggest } from "../dist/index.js";
import {
  affinity,
  bugs,
  comparable,
  flo,
  genie,
  genieMsl,
  htmlToText,
  innerHtml,
  isTitleHeader,
  parseHtml,
  parseLrc,
  pickTrack,
  plainFrom,
  sameArtist,
  textOf,
  vibe,
} from "../dist/sources.js";

/**
 * 가짜 서버를 세운다. 무엇을 물었는지도 적어 둔다.
 *
 * @param {Function} reply - 주소를 받아 본문을 돌려준다. 던지면 그 요청이 막힌 것이다.
 * @returns {{ fetch: Function, asked: string[] }} 가짜 fetch 와 물어본 주소들.
 */
function serve(reply) {
  const asked = [];
  const fake = async (url) => {
    asked.push(String(url));
    const body = reply(String(url));
    return { ok: true, status: 200, text: async () => body };
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

test("이름은 어떻게 적혀도 같게 접힌다", () => {
  assert.equal(comparable("아이유 (IU)"), comparable("아이유IU"));
  assert.equal(comparable("Ｇｉｒｌ"), "girl"); // NFKC 로 전각이 반각이 된다
  assert.equal(comparable("!!!"), "");
});

test("정확히 같은 제목이 포함하는 제목을 항상 이긴다", () => {
  // 「SWIM BTS」 검색 1위였던 「I Swim How Bts」가 진짜 「SWIM」을 밀어내던 자리.
  const rows = [
    ["a", "I Swim How Bts", "누구"],
    ["b", "SWIM", "BTS"],
  ];
  assert.equal(pickTrack(rows, "SWIM", "BTS", (one) => [one[1], one[2]])[0], "b");
});

test("제목이 안 맞는 곡은 고르지 않는다", () => {
  // genie 가 HOYO-MiX 질의에 Tyler, The Creator 의 「Window」를 돌려주던 자리.
  const rows = [["x", "Window", "Tyler, The Creator"]];
  assert.equal(pickTrack(rows, "The Wolf Is Coming", "HOYO-MiX", (one) => [one[1], one[2]]), null);
});

test("가수는 동점을 가를 뿐, 버리지는 않는다", () => {
  // MusicBrainz 는 「IU」, 한국 서비스는 「아이유」. 가수 불일치로 버리면 정상 곡을 다 잃는다.
  const rows = [["a", "밤편지", "아이유"]];
  assert.equal(pickTrack(rows, "밤편지", "IU", (one) => [one[1], one[2]])[0], "a");
  const covers = [
    ["cover", "밤편지", "다른가수"],
    ["real", "밤편지", "아이유(IU)"],
  ];
  assert.equal(pickTrack(covers, "밤편지", "IU", (one) => [one[1], one[2]])[0], "real");
});

test("두 가지로 적힌 가수 이름은 한 사람이다", () => {
  assert.equal(sameArtist("아이유(IU)", "IU"), true);
  assert.equal(sameArtist("리도어 (Redoor)", "리도어"), true);
  assert.equal(sameArtist("검정치마", "혁오"), false);
  assert.equal(sameArtist(null, "IU"), false);
});

test("affinity 가 같음의 정도를 매긴다", () => {
  assert.equal(affinity("EVERYTHING", "everything"), 2);
  assert.equal(affinity("EVERYTHING (Inst.)", "EVERYTHING"), 1);
  assert.equal(affinity("전혀 다른 곡", "EVERYTHING"), 0);
  assert.equal(affinity(null, "EVERYTHING"), 0);
});

test("줄바꿈은 읽는 동안 살아남는다", () => {
  // 글자와 자식 태그의 순서를 잃으면 `<br>` 이 글 뒤로 밀려 가사가 한 줄로 뭉친다.
  const node = parseHtml("<div>첫째 줄<br>둘째 줄<br/>셋째 줄</div>");
  assert.deepEqual(htmlToText(innerHtml(node)).split("\n"), ["첫째 줄", "둘째 줄", "셋째 줄"]);
});

test("닫는 짝이 없는 태그도 마디로 남는다", () => {
  // 버리면 `<br>` 이 사라져 스물여덟 줄이 한 줄이 된다 — 순서까지 그대로여야 한다.
  const parts = parseHtml("<div>가사<br>가사</div>").first("div").parts;
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "가사");
  assert.equal(parts[1].tag, "br");
  assert.equal(parts[2], "가사");
});

test("rawText 는 줄바꿈을 지키고 textOf 는 안 지킨다", () => {
  // bugs 는 `<xmp>` 에 줄바꿈 그대로 담는다. 제목·가수는 뭉개도 되지만 가사는 안 된다.
  const node = parseHtml("<xmp>첫째 줄\n둘째 줄\n셋째 줄</xmp>").first("xmp");
  assert.deepEqual(node.rawText().trim().split("\n"), ["첫째 줄", "둘째 줄", "셋째 줄"]);
  assert.equal(textOf(node), "첫째 줄 둘째 줄 셋째 줄");
});

test("딱지 span 이 제목의 일부가 되지 않는다", () => {
  // genie 의 제목 칸에는 「곡명」 같은 딱지가 같이 들어 있다.
  const node = parseHtml('<div class="song_name"><strong>곡명</strong>영원은 그렇듯</div>').first("div");
  assert.equal(node.ownText(), "영원은 그렇듯");
  assert.ok(textOf(node).includes("곡명"));
});

test("속성은 다시 나와서 찾을 수 있다", () => {
  const node = parseHtml("<a onclick=\"goSongDetail('33186501');\">곡정보</a>");
  assert.ok(innerHtml(node).includes("goSongDetail('33186501')"));
});

test("속성 안의 > 로는 태그가 끊기지 않는다", () => {
  // 파이썬 판은 표준 파서가 막아 주던 자리다. 여기서는 직접 챙겨야 한다.
  const node = parseHtml('<tr trackid="7" onclick="if (a > b) go();"><p class="title">제목</p></tr>');
  const row = node.first("tr", { attr: "trackid" });
  assert.equal(row.attrs.trackid, "7");
  assert.equal(textOf(row.first("p", { cls: "title" })), "제목");
});

test("스크립트 안의 < 는 태그로 읽지 않는다", () => {
  // 검색 화면에는 인라인 스크립트가 붙어 온다. 그 안의 부등호로 트리가 무너지면 안 된다.
  const node = parseHtml('<div><script>if (a<b) { x("</div>") }</script><p>가사</p></div>');
  assert.equal(textOf(node.first("p")), "가사");
});

test("엔티티와 태그가 걷힌다", () => {
  // 줄마다 양끝을 다듬으므로 `&nbsp;` 가 줄 앞에 있으면 그 공백은 사라진다.
  assert.equal(htmlToText("<p>a &amp; b</p><p>&nbsp;c&#39;d</p>"), "a & b\nc'd");
  assert.equal(htmlToText("<p>a&nbsp;&nbsp;b</p>"), "a  b");
});

test("LRC 를 줄로 읽는다", () => {
  const got = parseLrc("[00:12.34]첫째\n[01:02.5]둘째\n태그 없는 줄");
  assert.deepEqual(
    got.map((one) => [one.timeMs, one.text]),
    [
      [12340, "첫째"],
      [62500, "둘째"],
    ],
  );
});

test("genie 의 열쇠는 밀리초다", () => {
  const got = genieMsl('lyrics({"12040":"둘째","400":"첫째"});');
  assert.deepEqual(
    got.map((one) => [one.timeMs, one.text]),
    [
      [400, "첫째"],
      [12040, "둘째"],
    ],
  );
  assert.deepEqual(genieMsl("망가진 응답"), []);
});

test("genie 의 제목 머리줄은 버리고 진짜 첫 소절은 남긴다", () => {
  // 「Half The World Away - Oasis」 같은 머리줄은 0ms 에 붙어 정렬을 한 줄씩 민다.
  assert.equal(isTitleHeader("Half The World Away - Oasis", "Half The World Away", "Oasis"), true);
  assert.equal(isTitleHeader("영원은 그렇듯", "영원은 그렇듯", "리도어"), true);
  // 제목으로 **시작하는** 진짜 첫 소절은 남겨야 한다.
  assert.equal(isTitleHeader("Swim, swim in the dark", "Swim", "BTS"), false);
  assert.equal(isTitleHeader("", "Swim", "BTS"), false);
});

test("평문이 없으면 시각 가사로 짓는다", () => {
  const synced = [
    { timeMs: 0, text: "첫째" },
    { timeMs: 1000, text: "둘째" },
  ];
  assert.equal(plainFrom(null, synced), "첫째\n둘째");
  assert.equal(plainFrom("  ", synced), "첫째\n둘째");
  assert.equal(plainFrom("있는 글", synced), "있는 글");
  assert.equal(plainFrom(null, []), "");
});

test("제공처가 준 「03:57」이 밀리초가 된다", () => {
  // 이것이 있어야 엉뚱한 영상을 길이로 거를 수 있다.
  assert.equal(playTime("03:57"), 237000);
  assert.equal(playTime("1:02:03"), 3723000); // 한 시간이 넘는 녹음
  assert.equal(playTime(null), null);
  assert.equal(playTime(""), null);
  assert.equal(playTime("모름"), null);
});

test("vibe 의 시각 가사는 나란한 두 배열에서 온다", async () => {
  // `startTimeIndex[i]`(초)가 `contents[0].text[i]` 와 짝이다. 평문이 비면 이것으로 짓는다.
  const fake = serve((url) =>
    JSON.stringify(
      url.includes("/v3/search/track")
        ? {
            response: {
              result: {
                tracks: [
                  {
                    trackId: 55,
                    trackTitle: "영원은 그렇듯",
                    playTime: "03:57",
                    artists: [{ artistName: "리도어(Redoor)" }],
                    album: { albumTitle: "어떤 앨범" },
                  },
                ],
              },
            },
          }
        : {
            response: {
              result: {
                lyric: {
                  normalLyric: { text: "" },
                  syncLyric: {
                    startTimeIndex: [0.4, 12.04],
                    contents: [{ languageType: "default", text: ["첫째", "둘째"] }],
                  },
                },
              },
            },
          },
    ),
  );
  const got = await withServer(fake, () => vibe("영원은 그렇듯", "리도어"));
  assert.equal(got.provider, "vibe");
  assert.equal(got.lyrics, "첫째\n둘째");
  assert.deepEqual(
    got.synced.map((one) => [one.timeMs, one.text]),
    [
      [400, "첫째"],
      [12040, "둘째"],
    ],
  );
  assert.equal(got.durationMs, 237000);
  assert.equal(got.album, "어떤 앨범");
});

test("bugs 의 제목은 앨범 표지 링크가 아니라 p.title 안의 a 다", async () => {
  // 행의 첫 a 를 집으면 표지 링크가 걸려 제목이 비고 곡을 못 고른다.
  const search =
    '<table><tr trackid="111"><td><a href="/album/1"><img alt="표지"></a>' +
    '<p class="title"><a href="/track/111" title="영원은 그렇듯">영원은 그렇듯</a></p>' +
    '<p class="artist"><a href="/artist/9">리도어</a></p></td></tr></table>';
  const track = '<div class="lyricsContainer"><xmp>첫째 줄\n둘째 줄\n셋째 줄</xmp></div>';
  const fake = serve((url) => (url.includes("/search/track") ? search : track));
  const got = await withServer(fake, () => bugs("영원은 그렇듯", "리도어"));
  assert.equal(got.title, "영원은 그렇듯");
  assert.equal(got.trackId, "111");
  // `<xmp>` 의 줄바꿈이 그대로 살아야 한다.
  assert.deepEqual(got.lyrics.split("\n"), ["첫째 줄", "둘째 줄", "셋째 줄"]);
});

test("genie 는 0ms 에 붙은 제목 머리줄을 떼고 준다", async () => {
  const search =
    '<table><tr songid="22"><a class="title" href="#"><span class="ico">곡명</span>영원은 그렇듯</a>' +
    '<a class="artist" href="#">리도어</a><a class="albumtitle" href="#">어떤 앨범</a></tr></table>';
  const msl = 'lyrics({"0":"영원은 그렇듯 - 리도어","400":"첫째","12040":"둘째"});';
  const fake = serve((url) => (url.includes("get_msl.asp") ? msl : search));
  const got = await withServer(fake, () => genie("영원은 그렇듯", "리도어"));
  assert.equal(got.lyrics, "첫째\n둘째");
  assert.deepEqual(
    got.synced.map((one) => one.timeMs),
    [400, 12040],
  );
  assert.equal(got.album, "어떤 앨범");
  assert.equal(fake.asked.length, 2, "시각 가사를 받았으면 상세 페이지는 안 연다");
});

test("flo 는 검색과 상세를 따로 묻고 길이를 함께 준다", async () => {
  const fake = serve((url) =>
    JSON.stringify(
      url.includes("/api/search/v2/search")
        ? {
            data: {
              list: [
                {
                  type: "TRACK",
                  list: [
                    { id: 7, name: "영원은 그렇듯", playTime: "03:57", artistList: [{ name: "리도어" }] },
                  ],
                },
              ],
            },
          }
        : { data: { name: "영원은 그렇듯", lyrics: "첫째\n둘째" } },
    ),
  );
  const got = await withServer(fake, () => flo("영원은 그렇듯", "리도어"));
  assert.equal(got.provider, "flo");
  assert.equal(got.lyrics, "첫째\n둘째");
  assert.equal(got.durationMs, 237000);
  assert.equal(got.trackId, "7");
});

test("한 곳이 막혀도 나머지로 간다", async () => {
  // 페이지를 읽는 쪽은 저쪽이 화면을 바꾸면 깨진다. 그때 통째로 멈추면 안 된다.
  const fake = serve((url) => {
    if (url.includes("apis.naver.com")) throw new Error("막혔다");
    return JSON.stringify(
      url.includes("/api/search/v2/search")
        ? {
            data: {
              list: [{ type: "TRACK", list: [{ id: 7, name: "영원은 그렇듯", artistList: [{ name: "리도어" }] }] }],
            },
          }
        : { data: { name: "영원은 그렇듯", lyrics: "첫째\n둘째" } },
    );
  });
  const got = await withServer(fake, () => fetchLyrics("영원은 그렇듯", "리도어", { providers: ["vibe", "flo"] }));
  assert.equal(got.length, 1);
  assert.equal(got[0].provider, "flo");
});

test("suggest 는 제목에 오타가 있으면 가수로 다시 묻는다", async () => {
  // 「offically missing you」로는 저쪽 검색도 0건이다. 그때 가수로 물어야 그 곡이 보인다.
  const fake = serve((url) =>
    JSON.stringify(
      url.includes("offically")
        ? { response: { result: { tracks: [] } } }
        : {
            response: {
              result: {
                tracks: [{ trackTitle: "Officially Missing You", artists: [{ artistName: "긱스(Geeks)" }] }],
              },
            },
          },
    ),
  );
  const got = await withServer(fake, () => suggest("offically missing you", "긱스"));
  assert.deepEqual(got, [{ title: "Officially Missing You", artist: "긱스(Geeks)" }]);
  assert.equal(fake.asked.length, 2, "제목으로 먼저 묻고, 없으면 가수로 다시 묻는다");
});

test("suggest 는 검색이 죽으면 지어내지 않는다", async () => {
  const fake = serve(() => {
    throw new Error("망이 안 된다");
  });
  const got = await withServer(fake, () => suggest("아무 곡", "아무개"));
  assert.deepEqual(got, []);
});
