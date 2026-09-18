# mora-lyrics

노래의 어느 순간에 어느 낱말이 불리는지 — [Mora](https://mora.junx.dev) 정렬 API 자바스크립트·타입스크립트 클라이언트.

**가진 가사를 그대로 보내면 됩니다.** 줄바꿈이 다르거나 괄호 표기가 달라도 서버가 지문으로 견주어 제 자리에 얹습니다. 가사를 서버의 표기에 맞출 필요가 없고, 얼마나 맞았는지는 `confidence` 로 돌아옵니다.

의존성이 없습니다 — 런타임의 `fetch` 만 씁니다. Node 18+ · 브라우저 · Deno · Bun 에서 그대로 돕니다. 공개 API 는 열쇠가 없고 CORS 가 열려 있어 브라우저에서 바로 불러도 됩니다.

```bash
npm install mora-lyrics
```

## 쓰기

```ts
import { Mora } from "mora-lyrics";

const mora = new Mora();
const got = await mora.align(lyrics, { artist: "검정치마", title: "EVERYTHING", durationMs: 293000 });

console.log(got.tier, got.confidence);     // word 0.97
for (const line of got.lines) {
  console.log(line.startMs, line.text);
}
```

곡은 셋 중 하나로 가리킵니다. **서버는 이 순서로 배타적으로** 봅니다 — ISRC 가 있으면 나머지는 아예 읽지 않습니다.

| | |
|---|---|
| `{ isrc: "KRA401200001" }` | 가장 정확합니다 |
| `{ mbid: "…" }` | MusicBrainz 녹음 id |
| `{ artist, title, durationMs }` | **길이가 필수입니다** — 같은 이름의 다른 녹음이 있습니다 |

셋 다 없으면 네트워크를 타기 전에 `TypeError` 로 막습니다.

## 가사는 어디서

Mora 는 **타이밍만** 줍니다. 가사 글은 부르는 쪽이 들고 있어야 하는데, 그것을 어디서 구하느냐가 매번 막히는 자리였습니다. 그래서 수집기가 쓰는 길을 그대로 넣었습니다.

```ts
const got = await mora.lyrics("영원은 그렇듯", "리도어");   // 받은 첫 곳
console.log(got.provider, got.lyrics);

const timed = await mora.align(got.lyrics, { artist: got.artist, title: got.title, durationMs: 237000 });
```

여럿을 견주려면:

```ts
import { fetchLyrics, suggest } from "mora-lyrics";

for (const one of await fetchLyrics("영원은 그렇듯", "리도어")) {
  const timed = await mora.align(one.lyrics, { artist: "리도어(Redoor)", title: "영원은 그렇듯", durationMs: 237000 });
  console.log(one.provider, one.lyrics.split("\n").length, "줄 →", timed.tier, timed.confidence.toFixed(3));
}
```

```
vibe   33줄 → word        1.000
flo    37줄 → word-approx 0.820
genie  28줄 → word        1.000
bugs   28줄 → word        1.000
```

제공처마다 줄 나눔이 다릅니다. **그대로 보내도 붙고**, 얼마나 맞았는지가 `confidence` 로 드러납니다.

| | 어떻게 | 시각 가사 | 곡 길이 | 앨범 자켓 |
|---|---|---|---|---|
| `vibe` · `flo` | JSON API | vibe 만 | 둘 다 (`durationMs`) | 둘 다 |
| `bugs` · `genie` | 페이지 읽기 | genie 만 | 없음 | 둘 다 |

`imageUrl` 은 네 곳 모두 줍니다 — **이미 받아 오는 응답 안에** 들어 있어 요청이 늘지 않습니다. 크기는 제공처가 정합니다(vibe 480 · genie 600 · bugs 200 · flo 는 주는 것 중 가장 큰 것). 주소는 온 그대로 싣고, genie 가 `//` 로 시작하는 주소를 줄 때만 빠진 스킴을 채웁니다.

열쇠는 필요 없습니다. 페이지를 읽는 쪽은 저쪽이 화면을 바꾸면 깨지는데, 그때는 **다른 곳이 받아 줍니다** — `fetchLyrics` 는 한 곳이 막혀도 나머지로 갑니다.

곡을 고르는 규칙은 수집기 것을 그대로 옮겼습니다: **제목 일치는 필수**, 가수는 같은 제목이 여럿일 때 **우선 신호로만**. 가수 불일치로 버리면 「IU」와 「아이유」처럼 표기가 다른 정상 곡을 전부 잃기 때문입니다.

제목을 틀리게 적었을 때는 `suggest()` 가 **거르지 않은** 검색 결과를 보여 줍니다 — 오타 때는 가수 이름만으로 다시 묻습니다.

```ts
await suggest("offically missing you", "긱스");
// [{ title: "Officially Missing You", artist: "긱스(Geeks)", album: "Officially Missing You (EP)",
//    imageUrl: "https://musicmeta-phinf.pstatic.net/album/…jpg?type=r480Fll&v=…",
//    durationMs: 211000, trackId: "2425458" }, …]
```

앨범·자켓·길이·곡 번호는 검색 응답에 이미 들어 있던 값이라 요청이 늘지 않습니다. **길이가 중요합니다** — 이 목록으로 고른 곡의 음원을 받을 때 제목으로 먼저 거르고 길이로 확인해야 엉뚱한 영상을 안 집습니다. 저쪽이 안 주면 그 칸은 아예 없습니다(`undefined` 가 아니라 키가 없습니다).

> 이 부분만 **Node 전용**입니다. 제공처들이 CORS 를 열어 두지 않았고, 브라우저에서는 `User-Agent` 도 못 세웁니다 — genie 의 19금 가사는 그 헤더로 갈립니다. 정렬 쪽은 브라우저에서도 그대로 돕니다.

## 지금 부르는 줄

```ts
import { Playhead } from "mora-lyrics";

const head = new Playhead(got);

function frame() {
  const now = head.at(audio.currentTime * 1000);
  if (now.line) draw(now.line.text, now.word, now.progress);
  requestAnimationFrame(frame);
}
```

`Playhead` 는 저번에 있던 자리에서 한두 칸만 봅니다 — 1초에 예순 번 물어도 값이 안 듭니다. 뒤로 감아도 맞습니다.

`Moment` 는 이렇게 생겼습니다:

```ts
{ line?, word?, progress, untilNextMs?, lineNumber? }
```

한 번만 물을 때는 `got.lineAt(ms)` · `got.wordAt(ms)` 로 충분합니다.

## 자막으로 내보내기

```ts
import { toLrc, toSrt, toVtt } from "mora-lyrics";

toLrc(got);                       // 낱말 시각까지(A2)
toLrc(got, { enhanced: false });  // 줄만
toSrt(got);
toVtt(got, { enhanced: true });
```

> **서버의 `alignAs()` 와 다릅니다.** 서버가 내주는 `lrc-a2` · `webvtt` · `ttml` · `lyricsfile` 은 **가사 글자를 담지 않습니다** — 큐 안에 코드포인트 범위 숫자가 들어갑니다. 재생기에 띄울 자막이 필요하면 위의 `toLrc()` 쪽을 쓰세요.

## 누가 불렀나

듀엣이나 화음이 있는 곡에서는 낱말마다 화자가 붙습니다.

```ts
const got = await mora.align(lyrics, { isrc: "…" });
for (const word of got.words) {
  console.log(word.text, word.speaker);      // 0, 1, …
}
```

서버의 화자 표는 **토큰 번호**로 키를 거는데 `/v1/align` 의 `spans` 는 시각이 붙은 것만 담아 오므로 배열 자리와 번호가 어긋납니다. 그래서 이 라이브러리는 토큰 자리를 `/v1/tokenize` 로 한 번 더 받아 맞춥니다.

- `{ speakers: "auto" }` (기본) — 화자 표가 **실제로 올 때만** 그 요청을 합니다. 한 사람이 부른 곡에서는 요청이 늘지 않습니다.
- `{ speakers: false }` — 절대 안 부릅니다. `word.speaker` 는 모두 `undefined` 입니다.

토큰을 안 받아 왔으면 `speaker` 를 **비워 둡니다. 잘못 붙이느니 비워 둡니다.**

## 오류

```ts
import { NotAligned, Ambiguous, MoraError } from "mora-lyrics";

try {
  const got = await mora.align(lyrics, { artist: "아이유", title: "밤편지", durationMs: 254000 });
} catch (error) {
  if (error instanceof NotAligned) { /* 곡이 없거나(404) 가사가 너무 달라 못 붙임(tier none) */ }
  else if (error instanceof Ambiguous) { /* 그 이름의 녹음이 여럿 — ISRC 로 물어야 함(409) */ }
  else if (error instanceof MoraError) { console.log(error.code, error.status); }
}
```

## 그 밖에

```ts
await mora.tokenize(text);                       // 서버와 같은 방식으로 자른 토큰
await mora.alignFingerprint(fp, { isrc: "…" });  // 가사 글자를 안 보내고 지문만
await mora.health();
```

`alignFingerprint` 는 글자를 서버에 보내고 싶지 않을 때 씁니다. 돌아오는 자리는 오프셋이 아니라 **토큰 번호·줄 번호**라서 화자 표와 그대로 맞습니다.

## 알아 둘 것

- **오프셋은 코드포인트인데 자바스크립트 문자열은 UTF-16 입니다.** 이모지가 하나라도 섞이면 그 뒤의 모든 자리가 밀립니다 — 이 라이브러리가 그 변환을 하므로 `word.text` 를 그대로 쓰시면 됩니다. 직접 `text.slice(word.start, word.end)` 하지 마세요.
- `tier` 는 `word` · `word-approx` · `line` · `none` 입니다. `line` 이면 `words` 가 비어 있고 줄 시각만 있습니다.
- 공개 API 는 열쇠가 필요 없습니다.
- 가사 한 편은 100만 자, 요청 본문은 2 MiB, 토큰은 10만 개까지입니다.

## 함께

- [mora-python](https://github.com/aodjo/mora-python) — 같은 API 의 파이썬 클라이언트
- [Mora](https://github.com/aodjo/Mora) — 서버와 정렬기

MIT
