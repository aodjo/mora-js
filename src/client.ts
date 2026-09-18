/**
 * Mora 공개 정렬 API 클라이언트.
 *
 * 의존성이 없다 — 런타임의 `fetch` 만 쓴다. Node 18+ · 브라우저 · Deno · Bun 에서 그대로 돈다.
 * 공개 API 는 열쇠가 없고 CORS 가 열려 있으므로 브라우저에서 바로 불러도 된다.
 */

import { Alignment, type Format, type Line, type Speaker, type Token, type Word } from "./models.js";
import { fetchLyrics, type Lyrics } from "./sources.js";

export const DEFAULT_BASE_URL = "https://mora.junx.dev";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const VERSION = "0.2.0";

/** 서버가 요청을 받아들이지 않았다. */
export class MoraError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`${code} (HTTP ${status})`);
    this.name = "MoraError";
  }
}

/**
 * 이 곡에는 쓸 수 있는 타이밍이 없다.
 *
 * 곡을 못 찾았을 때(404 `NOT_FOUND`)와 가사가 너무 달라 못 붙였을 때(200 인데 `tier` 가 `none`)가
 * 모두 여기로 온다 — 부르는 쪽에서는 둘 다 「띄울 것이 없다」로 같기 때문이다. 어느 쪽인지는
 * `code` 로 갈린다.
 */
export class NotAligned extends MoraError {
  constructor(code: string, status: number) {
    super(code, status);
    this.name = "NotAligned";
  }
}

/** 가수·제목으로 물었는데 그 이름의 녹음이 여럿이다. ISRC 나 MBID 로 물어야 한다. */
export class Ambiguous extends MoraError {
  constructor(code: string, status: number) {
    super(code, status);
    this.name = "Ambiguous";
  }
}

/** 곡을 가리키는 세 가지 길. 서버는 이 순서로 **배타적으로** 본다. */
export type Recording =
  | { isrc: string }
  | { mbid: string }
  | { artist: string; title: string; durationMs: number };

export interface Options {
  /** 가사 언어(BCP-47). 토크나이저가 참고한다. */
  language?: string;
}

export interface AlignOptions extends Options {
  /**
   * 화자를 붙일지.
   *
   * `"auto"`(기본)는 화자 표가 실제로 올 때만 `/v1/tokenize` 를 한 번 더 부른다.
   */
  speakers?: "auto" | boolean;
}

interface Payload {
  tier?: string;
  confidence?: number;
  tokenizer?: string;
  alignment_id?: number;
  lines?: Array<[number, number, number, number]>;
  spans?: Array<[number, number, number, number, number]>;
  speaker_turns?: Array<[number, number, number, number]>;
  word_speakers?: Array<[number, number, number]>;
  line_speakers?: Array<[number, number, number]>;
}

/**
 * Build the identifier half of a request body.
 *
 * 서버는 셋을 **배타적으로** 본다 — ISRC 가 있으면 나머지를 아예 읽지 않는다. 그러니 여기서도
 * 같은 순서로 하나만 싣는다. 타입이 막아 주지만 자바스크립트에서 부르는 쪽은 그 보호를 못 받으니
 * 네트워크를 타기 전에 여기서 막는다 — 서버까지 갔다 오면 왕복 한 번을 버리고, 400 이라는 답은
 * 부르는 쪽의 실수를 가리키지 않는다.
 *
 * @param {Recording} recording - How the caller named the song.
 * @returns {Record<string, unknown>} The identifier fields.
 * @throws {TypeError} When nothing identifies the recording.
 */
function identify(recording: Recording): Record<string, unknown> {
  if ("isrc" in recording && recording.isrc) return { isrc: recording.isrc };
  if ("mbid" in recording && recording.mbid) return { mbid: recording.mbid };
  const named = recording as { artist?: string; title?: string; durationMs?: number };
  if (named.artist && named.title && Number.isFinite(named.durationMs)) {
    return { artist: named.artist, title: named.title, duration_ms: Math.round(named.durationMs as number) };
  }
  throw new TypeError("곡을 가리키려면 isrc, mbid, 또는 artist·title·durationMs 가 필요하다");
}

/**
 * Map codepoint offsets onto JavaScript string positions.
 *
 * 서버는 오프셋을 코드포인트로 센다. 자바스크립트 문자열은 UTF-16 코드유닛으로 세므로, 보조평면
 * 글자 — 이모지, 일부 한자 — 가 하나라도 섞이면 그 뒤의 **모든** 자리가 밀린다. 가사에 이모지는
 * 드물지 않고, 어긋난 결과는 조용히 틀린 낱말을 가리킨다. 파이썬 판에는 없는 함정이다.
 *
 * @param {string} text - The lyric text as the caller sent it.
 * @returns {number[]} For each codepoint index, where it starts in UTF-16 units.
 */
function codepointIndex(text: string): number[] {
  const map: number[] = [];
  for (let unit = 0; unit < text.length; ) {
    map.push(unit);
    unit += (text.codePointAt(unit) ?? 0) > 0xffff ? 2 : 1;
  }
  map.push(text.length);
  return map;
}

/**
 * Turn the server's number arrays into words and lines.
 *
 * 화자를 붙이려면 토큰 번호가 필요한데 `spans` 에는 없다 — `tokens` 를 받아 왔을 때만 자리로
 * 번호를 되찾아 붙인다. 안 받아 왔으면 `speaker` 를 비워 둔다. **잘못 붙이느니 비워 둔다.**
 *
 * @param {Payload} payload - What `/v1/align` answered.
 * @param {string} text - The lyric text that was sent.
 * @param {Token[] | undefined} tokens - The same text tokenized, when speakers are wanted.
 * @returns {Alignment} The parsed alignment.
 */
function parse(payload: Payload, text: string, tokens: Token[] | undefined): Alignment {
  const index = codepointIndex(text);
  const cut = (start: number, end: number): string =>
    text.slice(index[Math.min(Math.max(start, 0), index.length - 1)]!, index[Math.min(Math.max(end, 0), index.length - 1)]!);

  const wordSpeaker = new Map<number, number>();
  for (const [token, who] of payload.word_speakers ?? []) wordSpeaker.set(token, who);
  const lineSpeaker = new Map<number, number>();
  for (const [line, who] of payload.line_speakers ?? []) lineSpeaker.set(line, who);

  /** 토큰의 시작 자리 → 토큰 번호. `spans` 는 토큰의 자리를 그대로 옮겨 오므로 이것으로 맞는다. */
  const numberOf = new Map<number, number>();
  const lineOf = new Map<number, number>();
  (tokens ?? []).forEach((one, position) => {
    numberOf.set(one.start, position);
    lineOf.set(position, one.line);
  });

  const words: Word[] = (payload.spans ?? []).map(([start, end, startMs, endMs, interpolated]) => {
    const token = numberOf.get(start);
    const word: Word = {
      text: cut(start, end),
      startMs,
      endMs,
      interpolated: interpolated === 1,
      start,
      end,
    };
    if (token !== undefined) {
      word.token = token;
      const who = wordSpeaker.get(token);
      if (who !== undefined) word.speaker = who;
    }
    return word;
  });

  const lines: Line[] = (payload.lines ?? []).map(([start, end, startMs, endMs]) => {
    // 줄에 속한 낱말은 오프셋으로 가른다. 서버가 줄 번호를 따로 주지 않기 때문이다.
    const held = words.filter((one) => one.start >= start && one.end <= end);
    const line: Line = { text: cut(start, end), startMs, endMs, words: held, start, end };
    // 줄 번호도 배열 자리가 아니다. 토큰을 받아 왔으면 그 줄 번호로, 아니면 비워 둔다.
    const number = held.map((one) => (one.token === undefined ? undefined : lineOf.get(one.token)))
      .find((one) => one !== undefined);
    if (number !== undefined) {
      line.index = number;
      const who = lineSpeaker.get(number);
      if (who !== undefined) line.speaker = who;
    }
    return line;
  });

  const speakers: Speaker[] = (payload.speaker_turns ?? []).map(([speakerId, startMs, endMs, confidence]) => ({
    speakerId,
    startMs,
    endMs,
    confidence,
  }));

  return new Alignment(
    (payload.tier ?? "none") as Alignment["tier"],
    payload.confidence ?? 0,
    payload.tokenizer ?? "",
    payload.alignment_id ?? 0,
    lines,
    words,
    speakers,
    text,
  );
}

/**
 * Mora 공개 API 를 부르는 클라이언트.
 *
 * 맞춰 둔 타이밍은 서버가 들고 있고, 부르는 쪽은 **자기가 가진 가사를 그대로** 보낸다. 줄바꿈이
 * 다르거나 괄호 표기가 달라도 서버가 지문으로 견주어 제 자리에 얹어 주므로, 가사를 서버의 표기에
 * 맞출 필요가 없다. 얼마나 맞았는지는 `confidence` 로 돌아온다.
 *
 * @example
 *   const mora = new Mora();
 *   const got = await mora.align(lyrics, { artist: "검정치마", title: "EVERYTHING", durationMs: 293000 });
 *   for (const line of got.lines) console.log(line.startMs, line.text);
 */
export class Mora {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly userAgent: string;

  constructor(
    baseUrl: string = DEFAULT_BASE_URL,
    options: { timeoutMs?: number; userAgent?: string } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? `mora-lyrics-js/${VERSION}`;
  }

  /**
   * 가사에 시각을 붙여 돌려준다.
   *
   * 곡은 ISRC, MusicBrainz id, 또는 (artist, title, durationMs) 셋 중 하나로 가리킨다. 길이로도
   * 견주므로 artist·title 만으로는 부족하다 — 같은 이름의 다른 녹음이 있다.
   *
   * **화자**: 서버가 주는 화자 표는 **토큰 번호**로 키를 걸지만 `/v1/align` 의 `spans` 는 시각이
   * 붙은 것만 담아 오므로 배열 자리와 토큰 번호가 어긋난다. 그래서 토큰 자리를 `/v1/tokenize` 로
   * 한 번 더 받아 맞춘다. `"auto"`(기본)는 **화자 표가 실제로 올 때만** 그 요청을 한다 — 한 사람이
   * 부른 곡에서는 요청이 늘지 않는다. `false` 면 절대 안 부르고 `word.speaker` 는 모두 undefined 다.
   *
   * @param {string} text - 가진 가사 전문.
   * @param {Recording} recording - 곡을 가리키는 것.
   * @param {AlignOptions} options - 언어와 화자 설정.
   * @returns {Promise<Alignment>} 시각이 붙은 가사.
   * @throws {NotAligned} 곡을 못 찾았거나 붙일 만큼 닮지 않았을 때.
   * @throws {Ambiguous} 가수·제목이 여러 녹음에 걸릴 때.
   * @throws {MoraError} 그 밖에 서버가 거절했을 때.
   */
  async align(text: string, recording: Recording, options: AlignOptions = {}): Promise<Alignment> {
    const body = { ...identify(recording), text, ...this.#language(options) };
    const payload = (await this.#post("/v1/align", body)) as Payload;
    if ((payload.tier ?? "none") === "none") throw new NotAligned("NO_ALIGNMENT", 200);

    const wants = (payload.word_speakers?.length ?? 0) > 0 || (payload.line_speakers?.length ?? 0) > 0;
    const speakers = options.speakers ?? "auto";
    let tokens: Token[] | undefined;
    if (speakers === true || (speakers === "auto" && wants)) {
      // 토크나이저는 서버가 고른 것을 그대로 따라야 한다 — 다른 것으로 자르면 번호가 어긋난다.
      tokens = await this.tokenize(text, { tokenizer: payload.tokenizer ?? "", ...this.#language(options) });
    }
    return parse(payload, text, tokens);
  }

  /**
   * 서버가 직접 적어 주는 형식으로 받는다.
   *
   * **주의**: `lrc-a2` · `webvtt` · `ttml` · `lyricsfile` 은 **가사 글자를 담지 않는다** — 큐 안에
   * 코드포인트 범위 숫자가 들어간다. 그 글만으로는 재생기에 띄울 수 없다. 사람이 읽을 자막이
   * 필요하면 `align()` 뒤에 `toLrc()` · `toSrt()` · `toVtt()` 를 쓴다.
   *
   * @param {string} text - 가진 가사 전문.
   * @param {Format} format - `lrc-a2` · `lyricsfile` · `ttml` · `webvtt` 중 하나.
   * @param {Recording} recording - 곡을 가리키는 것.
   * @param {Options} options - 언어.
   * @returns {Promise<string>} 서버가 적어 준 글.
   */
  async alignAs(text: string, format: Format, recording: Recording, options: Options = {}): Promise<string> {
    const body = { ...identify(recording), text, ...this.#language(options) };
    return (await this.#post(`/v1/align?format=${encodeURIComponent(format)}`, body, true)) as string;
  }

  /**
   * 가사를 서버와 같은 방식으로 잘라 본다.
   *
   * @param {string} text - 자를 가사.
   * @param {object} options - `tokenizer` 는 `unilab-v1`·`unilab-v2`. 비우면 서버 기본값(v2).
   * @returns {Promise<Token[]>} 토큰마다 글자·코드포인트 자리·줄 번호.
   */
  async tokenize(text: string, options: { tokenizer?: string; language?: string } = {}): Promise<Token[]> {
    const body: Record<string, unknown> = { text };
    if (options.tokenizer) body.tokenizer = options.tokenizer;
    if (options.language !== undefined) body.language = options.language;
    const payload = (await this.#post("/v1/tokenize", body)) as { tokens?: Array<[number, number, number]> };
    const index = codepointIndex(text);
    const cut = (start: number, end: number): string =>
      text.slice(index[Math.min(start, index.length - 1)]!, index[Math.min(end, index.length - 1)]!);
    return (payload.tokens ?? []).map(([start, end, line]) => ({ text: cut(start, end), start, end, line }));
  }

  /**
   * 가사 글자 없이 **지문만** 보내 시각을 받는다.
   *
   * 글자를 서버에 보내고 싶지 않을 때 쓴다. 돌아오는 `spans`·`lines` 는 오프셋이 아니라 **토큰
   * 번호·줄 번호**라서, 화자 표와 자리가 그대로 맞는다.
   *
   * @param {object} fingerprint - `{ lens: number[][], types: number[][] }`.
   * @param {Recording} recording - 곡을 가리키는 것.
   * @returns {Promise<unknown>} 서버가 준 그대로.
   */
  async alignFingerprint(
    fingerprint: { lens: number[][]; types: number[][] },
    recording: Recording,
  ): Promise<unknown> {
    return this.#post("/v1/align/fingerprint", { ...identify(recording), fingerprint });
  }

  /**
   * 가사 글을 제공처에서 가져온다 — Mora 는 타이밍만 주기 때문이다.
   *
   * vibe · flo · genie · bugs 에 차례로 물어 **처음 받은 것**을 돌려준다. 여럿을 견주고 싶으면
   * `fetchLyrics()` 를 직접 쓴다.
   *
   * 제공처들은 CORS 를 열어 두지 않았으므로 이것은 **Node 에서만** 된다. 나머지 메서드는 브라우저에서도
   * 그대로 돈다.
   *
   * @param {string} title - 곡 이름.
   * @param {string} [artist] - 가수 이름. 같은 제목의 다른 곡을 가려낸다.
   * @param {object} [options={}] - `providers` 물어볼 곳, `timeoutMs` 기다릴 밀리초(비우면 이 클라이언트의 값).
   * @returns {Promise<Lyrics | null>} 받은 가사. 아무 곳도 못 주면 null.
   *
   * @example
   * const got = await mora.lyrics("영원은 그렇듯", "리도어");
   * const timed = await mora.align(got.lyrics, { artist: got.artist, title: got.title, durationMs: 237000 });
   */
  async lyrics(
    title: string,
    artist?: string,
    options: { providers?: string[]; timeoutMs?: number } = {},
  ): Promise<Lyrics | null> {
    const got = await fetchLyrics(title, artist, {
      providers: options.providers,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      first: true,
    });
    return got[0] ?? null;
  }

  /** @returns {Promise<boolean>} 서버가 살아 있는가. */
  async health(): Promise<boolean> {
    try {
      await this.#request("GET", "/health", undefined);
      return true;
    } catch {
      return false;
    }
  }

  // ── 안쪽 ──────────────────────────────────────────────────────────────

  /**
   * Put the language field in a body only when the caller gave one.
   *
   * @param {Options} options - What the caller passed.
   * @returns {Record<string, string>} The language field, or nothing.
   */
  #language(options: Options): Record<string, string> {
    return options.language === undefined ? {} : { language: options.language };
  }

  /**
   * Send a JSON body and read what comes back.
   *
   * @param {string} path - Path under the base URL.
   * @param {Record<string, unknown>} body - What to send.
   * @param {boolean} raw - True to hand back the text as-is.
   * @returns {Promise<unknown>} The parsed JSON, or the raw text.
   */
  async #post(path: string, body: Record<string, unknown>, raw = false): Promise<unknown> {
    const text = await this.#request("POST", path, JSON.stringify(body));
    return raw ? text : JSON.parse(text);
  }

  /**
   * Make one request, turning a refusal into the error the caller can act on.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Path under the base URL.
   * @param {string | undefined} body - JSON body, when there is one.
   * @returns {Promise<string>} The response body.
   * @throws {MoraError} When the server refuses or cannot be reached.
   */
  async #request(method: string, path: string, body: string | undefined): Promise<string> {
    // AbortSignal.timeout 은 Node 18+ · 요즘 브라우저에 다 있다. 없으면 제한 없이 간다.
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        // 브라우저에서는 User-Agent 를 못 세운다 — 세우려 하면 요청이 통째로 막힌다.
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new MoraError(`UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    const text = await response.text();
    if (response.ok) return text;

    let code = "UNKNOWN";
    try {
      code = String((JSON.parse(text) as { error?: string }).error ?? code);
    } catch {
      /* 서버가 JSON 이 아닌 것을 보냈다. 상태 코드만으로 간다. */
    }
    // 곡을 못 찾은 것, 이름이 겹치는 것, 서버가 고장난 것은 부르는 쪽에서 다르게 다뤄야 한다.
    if (response.status === 404) throw new NotAligned(code, 404);
    if (response.status === 409) throw new Ambiguous(code, 409);
    throw new MoraError(code, response.status);
  }
}
