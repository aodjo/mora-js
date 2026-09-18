/**
 * 가사를 제공처에서 가져온다 — bugs · flo · genie · vibe.
 *
 * Mora 는 **타이밍만** 준다. 가사 글은 부르는 쪽이 들고 있어야 하는데, 그것을 어디서 구하느냐가
 * 매번 막히는 자리였다. 그래서 Mora 수집기가 쓰는 길을 그대로 옮겨 왔다.
 *
 * 열쇠는 필요 없다. flo 와 vibe 는 JSON API 를 부르고, bugs · genie 는 페이지를 읽는다.
 * 페이지를 읽는 쪽은 저쪽이 화면을 바꾸면 깨진다 — 그때는 다른 제공처가 받아 준다.
 *
 * 의존성은 없다. Node 에는 `html.parser` 같은 것이 없으므로 HTML 은 여기서 직접 읽는다.
 *
 * 이쪽은 **Node 용**이다. 제공처들은 CORS 를 열어 두지 않았고, 브라우저에서는 `User-Agent` 도
 * 못 세운다 — genie 의 19금 가사는 그 헤더로 갈린다.
 *
 * @example
 *   import { fetchLyrics } from "mora-lyrics";
 *
 *   for (const got of await fetchLyrics("영원은 그렇듯", "리도어")) {
 *     console.log(got.provider, got.lyrics.split("\n").length, "줄");
 *   }
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Genie 는 19금 곡의 가사를 일반 브라우저에게 숨긴다. 검색 색인을 위해 크롤러에게는 열어 두므로,
 * **가사를 읽을 때만** 크롤러로 묻는다. 실측: 12만 바이트(가사 없음) → 17만 바이트(가사 전문).
 * 검색은 이 UA 로 물으면 결과가 비므로 그대로 둔다.
 */
const CRAWLER_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/150.0.0.0 Safari/537.36";

/** 한 제공처가 한 요청에서 기다리는 시간. */
export const LYRIC_TIMEOUT_MS = 12_000;

// ── 자료 ──────────────────────────────────────────────────────────────────

/** 시각이 붙은 가사 한 줄 — 제공처가 줄 때만 온다. */
export interface LyricLine {
  timeMs: number;
  text: string;
}

/** 한 제공처가 돌려준 가사. */
export interface Lyrics {
  provider: string;
  lyrics: string;
  title?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  url?: string | undefined;
  trackId?: string | undefined;
  /**
   * 제공처가 말하는 곡 길이(ms). 이것이 있으면 엉뚱한 영상을 길이로 걸러낼 수 있다 — 산토리
   * 자리에 아크라포빅 영상이 붙었던 일이 바로 그 검사가 없어서였다. JSON 제공처(vibe·flo)만 준다.
   */
  durationMs?: number | undefined;
  /**
   * 앨범 자켓 주소. 네 곳 모두 **이미 받아 오는 응답 안에** 들어 있어 요청이 늘지 않는다.
   * 크기는 제공처마다 다르다 — vibe 480 · genie 600 · bugs 200 · flo 는 가장 큰 것.
   */
  imageUrl?: string | undefined;
  /** 제공처가 시각까지 주면 채워진다. Mora 에 보낼 때는 안 쓰지만, 견주어 볼 수는 있다. */
  synced: LyricLine[];
}

/**
 * 검색만 해 본 결과 한 줄 — 가사는 안 딸려 온다.
 *
 * 뒤의 세 칸은 검색 응답에 이미 들어 있던 값이라 더 물을 것이 없다. 저쪽이 안 주면 **키를 아예
 * 안 넣는다** — `undefined` 를 넣어 두면 「받았는데 비었다」와 「안 받았다」를 못 가른다.
 */
export interface Suggestion {
  title: string;
  artist: string;
  album?: string;
  /**
   * 제공처가 말하는 곡 길이(ms). 음원을 고를 때 제목으로 먼저 거르고 **이것으로 확인**한다 —
   * 산토리 자리에 아크라포빅 영상이 붙었던 일이 그 검사가 없어서였다.
   */
  durationMs?: number;
  trackId?: string;
  /** 앨범 자켓 주소. 검색 응답에 온 그대로다 — 크기 지정(`type=r480Fll`)도 손대지 않는다. */
  imageUrl?: string;
}

export interface FetchOptions {
  /** 물어볼 곳. 비우면 네 곳 모두. */
  providers?: string[] | undefined;
  /** 한 요청이 기다릴 밀리초. */
  timeoutMs?: number | undefined;
  /** true 면 하나 받는 즉시 멈춘다. */
  first?: boolean | undefined;
}

// ── 고르기 ────────────────────────────────────────────────────────────────

/**
 * Fold a name for comparison: NFKC, lower case, letters and digits only.
 *
 * @param {string} value - The name.
 * @returns {string} The folded form.
 *
 * @example
 * comparable("아이유 (IU)"); // "아이유iu"
 */
export function comparable(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

/**
 * How close two titles are: 2 same, 1 one contains the other, 0 different.
 *
 * 포함만으로 같은 곡 취급하면 「SWIM BTS」 검색 1위였던 「I Swim How Bts」가 진짜 「SWIM」을
 * 밀어낸다 — 정확 일치가 항상 이겨야 한다.
 *
 * @param {string | null | undefined} candidate - The title found.
 * @param {string} wanted - The title asked for.
 * @returns {number} 0, 1 or 2.
 *
 * @example
 * affinity("EVERYTHING (Inst.)", "EVERYTHING"); // 1
 */
export function affinity(candidate: string | null | undefined, wanted: string): number {
  if (candidate === null || candidate === undefined) return 0;
  const a = comparable(candidate);
  const b = comparable(wanted);
  if (!a || !b) return 0;
  if (a === b) return 2;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}

/**
 * Whether two artist names overlap — 「아이유(IU)」 and 「IU」 count as one.
 *
 * @param {string | null | undefined} candidate - The name found.
 * @param {string | null | undefined} wanted - The name asked for.
 * @returns {boolean} True when they name the same act.
 *
 * @example
 * sameArtist("리도어 (Redoor)", "리도어"); // true
 */
export function sameArtist(candidate: string | null | undefined, wanted: string | null | undefined): boolean {
  if (candidate === null || candidate === undefined || wanted === null || wanted === undefined) return false;
  const a = comparable(candidate);
  const b = comparable(wanted);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Pick the search result most likely to be the song that was asked for.
 *
 * 제목 일치를 **필수**로 한다. 모든 제공처가 검색 첫 항목을 검증 없이 집던 시절, genie 는
 * HOYO-MiX 게임 OST 질의에 Tyler, The Creator 의 「Window」를 돌려줬고 melon 은 라틴어 가사
 * 하나를 88곡에 붙였다. 관측된 오염은 전부 제목 불일치였다.
 *
 * 가수는 **선호 신호로만** 쓴다. MusicBrainz 는 「IU」를 주고 한국 서비스는 「아이유」를
 * 보여주므로, 가수 불일치만으로 버리면 표기가 다른 정상 곡을 전부 잃는다.
 *
 * @param {readonly T[]} items - Search results.
 * @param {string} wantedTitle - The title asked for.
 * @param {string | null | undefined} wantedArtist - The artist asked for, if known.
 * @param {Function} read - Reads [title, artist] out of one result.
 * @returns {T | null} The best result, or null when no title matches.
 *
 * @example
 * pickTrack(rows, "SWIM", "BTS", (one) => [one.name, one.singer]);
 */
export function pickTrack<T>(
  items: readonly T[],
  wantedTitle: string,
  wantedArtist: string | null | undefined,
  read: (item: T) => [string | null | undefined, string | null | undefined],
): T | null {
  let best: T | null = null;
  let bestRank = 0;
  for (const item of items) {
    const [title, artist] = read(item);
    const close = affinity(title, wantedTitle);
    if (close === 0) continue;
    const rank = close * 2 + (sameArtist(artist, wantedArtist) ? 1 : 0);
    if (rank > bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}

// ── 글 다듬기 ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&apos;": "'",
  "&quot;": '"',
};

/**
 * Turn a lyric fragment of HTML into plain lines.
 *
 * @param {string} html - The fragment.
 * @returns {string} Plain text, one line per sung line.
 *
 * @example
 * htmlToText("<p>첫째 줄<br>둘째 줄</p>"); // "첫째 줄\n둘째 줄"
 */
export function htmlToText(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div)>/gi, "\n");
  out = out.replace(/<[^>]+>/g, "");
  for (const [mark, plain] of Object.entries(ENTITIES)) out = out.split(mark).join(plain);
  out = out
    .split("\n")
    .map((one) => one.trim())
    .join("\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Read `[mm:ss.xx] 가사` lines.
 *
 * @param {string} lrc - The LRC text.
 * @returns {LyricLine[]} Lines in time order.
 *
 * @example
 * parseLrc("[00:12.34]첫째"); // [{ timeMs: 12340, text: "첫째" }]
 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const row of lrc.split(/\r\n|\r|\n/)) {
    const tags = [...row.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;
    const text = row.replace(/\[[^\]]*\]/g, "").trim();
    for (const tag of tags) {
      const fraction = tag[3];
      const frac = fraction === undefined ? 0 : Number(`${fraction}00`.slice(0, 3));
      out.push({ timeMs: (Number(tag[1]) * 60 + Number(tag[2])) * 1000 + frac, text });
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Read a provider's `03:57` into milliseconds.
 *
 * vibe 와 flo 가 곡 길이를 이 꼴로 준다. 시(hour)까지 오는 곡도 있으므로 칸 수로 센다.
 *
 * @param {string | null | undefined} value - The `mm:ss` or `hh:mm:ss` reading.
 * @returns {number | null} Milliseconds, or null when it is not a time.
 *
 * @example
 * playTime("03:57"); // 237000
 */
export function playTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parts = String(value).trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((one) => /^\d+$/.test(one))) return null;
  let whole = 0;
  for (const one of parts) whole = whole * 60 + Number(one);
  return whole * 1000;
}

/**
 * Take the plain lyric if there is one, else build it from the synced lines.
 *
 * @param {string | null | undefined} plain - The plain text a provider gave.
 * @param {readonly LyricLine[] | null | undefined} synced - Its synced lines.
 * @returns {string} The lyric text.
 *
 * @example
 * plainFrom(null, [{ timeMs: 0, text: "첫째" }]); // "첫째"
 */
export function plainFrom(
  plain: string | null | undefined,
  synced: readonly LyricLine[] | null | undefined,
): string {
  if ((plain ?? "").trim()) return (plain ?? "").trim();
  if (synced !== null && synced !== undefined && synced.length > 0) {
    return synced.map((one) => one.text).join("\n").trim();
  }
  return "";
}

// ── 작은 DOM ──────────────────────────────────────────────────────────────

/** 마디 안에 든 것 — 글자이거나 자식 태그다. */
export type Part = string | Node;

/**
 * A tag, what it carried, and what was inside it — **in the order it appeared**.
 *
 * 글자와 자식 태그를 한 목록에 순서대로 담는다. 처음에는 글자를 한 칸에 모아 두었는데, 그러면
 * `가사<br>가사` 의 `<br>` 이 글 뒤로 밀려 줄바꿈이 통째로 사라졌다 — 가사가 한 줄로 뭉쳐 나온
 * 것이 그 탓이다.
 */
export class Node {
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string>,
    readonly parts: Part[] = [],
  ) {}

  /** @returns {Node[]} 이 마디 바로 아래의 태그들. */
  get children(): Node[] {
    return this.parts.filter((one): one is Node => typeof one !== "string");
  }

  /** @returns {string} 이 마디에 바로 들어 있는 글자. 자식 태그의 글자는 안 센다. */
  get text(): string {
    return this.parts.filter((one): one is string => typeof one === "string").join("");
  }

  /**
   * Whether this tag carries a class.
   *
   * @param {string} name - The class to look for.
   * @returns {boolean} True when it carries it.
   */
  hasClass(name: string): boolean {
    return (this.attrs["class"] ?? "").split(/\s+/).includes(name);
  }

  /**
   * Walk this node and everything under it, handing back what matches.
   *
   * @param {string | null} [tag=null] - Tag name to match.
   * @param {object} [want={}] - `cls` a class it must carry, `attr` an attribute it must have,
   *   `holds` text its `href` must contain.
   * @returns {Generator<Node>} Matching nodes, outermost first.
   *
   * @example
   * for (const row of page.find("tr", { attr: "trackid" })) console.log(row.attrs.trackid);
   */
  *find(
    tag: string | null = null,
    want: { cls?: string; attr?: string; holds?: string } = {},
  ): Generator<Node> {
    for (const one of this.children) {
      const fits =
        (tag === null || one.tag === tag) &&
        (want.cls === undefined || one.hasClass(want.cls)) &&
        (want.attr === undefined || want.attr in one.attrs) &&
        (want.holds === undefined || (one.attrs["href"] ?? "").includes(want.holds));
      if (fits) yield one;
      yield* one.find(tag, want);
    }
  }

  /**
   * The first match of `find`, or null.
   *
   * @param {string | null} [tag=null] - Tag name to match.
   * @param {object} [want={}] - The same conditions `find` takes.
   * @returns {Node | null} The first matching node.
   */
  first(tag: string | null = null, want: { cls?: string; attr?: string; holds?: string } = {}): Node | null {
    for (const one of this.find(tag, want)) return one;
    return null;
  }

  /**
   * Text directly inside this tag, not counting nested tags.
   *
   * Genie 의 제목 칸에는 「곡명」 같은 딱지 span 이 같이 들어 있다. 그것까지 읽으면 제목이 달라져
   * 곡을 못 고른다.
   *
   * @returns {string} The text of this node alone.
   */
  ownText(): string {
    return this.text.trim();
  }

  /**
   * All text under this node **with its line breaks kept**.
   *
   * Bugs 는 가사를 `<xmp>` 에 줄바꿈 그대로 담는다. 공백을 뭉개면 스물여덟 줄이 한 줄이 된다.
   *
   * @returns {string} The text, newlines intact.
   */
  rawText(): string {
    let out = "";
    for (const one of this.parts) out += typeof one === "string" ? one : one.rawText();
    return out;
  }
}

/** 닫는 짝이 없는 태그. 이것을 안 챙기면 트리가 통째로 한쪽으로 기운다. */
const VOID = new Set([
  "br", "img", "input", "meta", "link", "hr", "source", "area", "base", "col", "embed", "track", "wbr",
]);

/** 안쪽을 글자로만 읽는 태그. 스크립트 안의 `<` 를 태그로 읽으면 트리가 무너진다. */
const CDATA = new Set(["script", "style"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", bull: "•", times: "×", deg: "°", copy: "©", reg: "®", trade: "™",
};

/**
 * Turn character references back into the characters they stand for.
 *
 * @param {string} text - The text as it appeared in the page.
 * @returns {string} The text with `&amp;` and `&#39;` resolved.
 */
function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/**
 * Find where a tag closes, ignoring any `>` sitting inside a quoted attribute.
 *
 * `onclick="if (a > b) …"` 같은 속성이 흔하다. 첫 `>` 에서 끊으면 그 태그가 통째로 어긋난다.
 *
 * @param {string} html - The page.
 * @param {number} from - Where the tag began.
 * @returns {number} Index of the closing `>`, or -1 when there is none.
 */
function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let at = from; at < html.length; at += 1) {
    const letter = html[at]!;
    if (quote) {
      if (letter === quote) quote = "";
      continue;
    }
    if (letter === '"' || letter === "'") quote = letter;
    else if (letter === ">") return at;
  }
  return -1;
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]*)))?/g;

/**
 * Read a start tag's attributes into a plain record.
 *
 * @param {string} body - Everything after the tag name.
 * @returns {Record<string, string>} Attribute names, lower cased, to their values.
 */
function readAttrs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let found: RegExpExecArray | null = ATTR.exec(body);
  while (found !== null) {
    out[found[1]!.toLowerCase()] = unescape(found[2] ?? found[3] ?? found[4] ?? "");
    found = ATTR.exec(body);
  }
  return out;
}

/**
 * Read a page into nodes.
 *
 * 가사 페이지를 읽는 데 필요한 만큼만 한다. 닫는 짝이 없는 태그는 쌓지 않지만 **버리지도 않는다**
 * — 버리면 `<br>` 이 사라져 가사가 한 줄로 뭉친다.
 *
 * @param {string} html - The page.
 * @returns {Node} Its root.
 *
 * @example
 * parseHtml("<div>첫째<br>둘째</div>").first("div").parts.length; // 3
 */
export function parseHtml(html: string): Node {
  const root = new Node("#root", {});
  const stack: Node[] = [root];
  const push = (data: string): void => {
    if (data) stack[stack.length - 1]!.parts.push(unescape(data));
  };

  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) {
      push(html.slice(at));
      break;
    }
    push(html.slice(at, lt));

    if (html.startsWith("<!--", lt)) {
      const shut = html.indexOf("-->", lt + 4);
      at = shut < 0 ? html.length : shut + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const shut = html.indexOf(">", lt);
      at = shut < 0 ? html.length : shut + 1;
      continue;
    }

    const shut = tagEnd(html, lt + 1);
    if (shut < 0) {
      push(html.slice(lt));
      break;
    }
    const closing = html.startsWith("</", lt);
    const raw = html.slice(lt + (closing ? 2 : 1), shut);
    const selfClosing = !closing && raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const named = /^[a-zA-Z][^\s/>]*/.exec(body);
    at = shut + 1;
    if (named === null) {
      push(html.slice(lt, shut + 1));
      continue;
    }
    const tag = named[0].toLowerCase();

    if (closing) {
      for (let spot = stack.length - 1; spot > 0; spot -= 1) {
        if (stack[spot]!.tag === tag) {
          stack.length = spot;
          break;
        }
      }
      continue;
    }

    const node = new Node(tag, readAttrs(body.slice(named[0].length)));
    stack[stack.length - 1]!.parts.push(node);
    if (CDATA.has(tag) && !selfClosing) {
      const close = html.toLowerCase().indexOf(`</${tag}`, at);
      const inner = html.slice(at, close < 0 ? html.length : close);
      if (inner) node.parts.push(inner);
      at = close < 0 ? html.length : (tagEnd(html, close + 1) + 1 || html.length);
      continue;
    }
    if (!VOID.has(tag) && !selfClosing) stack.push(node);
  }
  return root;
}

/**
 * All text under a node, tags flattened and whitespace squeezed.
 *
 * @param {Node | null} node - The node.
 * @returns {string} Its text.
 *
 * @example
 * textOf(page.first("p", { cls: "artist" })); // "리도어 (Redoor)"
 */
export function textOf(node: Node | null): string {
  if (node === null) return "";
  return node.rawText().replace(/\s+/g, " ").trim();
}

/**
 * Rebuild a node's inner HTML, enough for `htmlToText` to read.
 *
 * 속성도 실어야 한다 — 찾을 것이 속성 안에 들어 있는 제공처가 있다.
 *
 * @param {Node | null} node - The node.
 * @returns {string} Its inner HTML.
 */
export function innerHtml(node: Node | null): string {
  if (node === null) return "";
  let out = "";
  for (const one of node.parts) {
    if (typeof one === "string") {
      out += one;
      continue;
    }
    const attrs = Object.entries(one.attrs)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
    out += `<${one.tag}${attrs}>${innerHtml(one)}</${one.tag}>`;
  }
  return out;
}

// ── 가져오기 ──────────────────────────────────────────────────────────────

/**
 * Fetch a page or an API answer.
 *
 * @async
 * @param {string} url - Where to ask.
 * @param {number} timeoutMs - Milliseconds to wait.
 * @param {Record<string, string>} [headers={}] - Extra headers.
 * @returns {Promise<string>} The body.
 * @throws {Error} When it does not answer, or answers with a refusal.
 */
async function get(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<string> {
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
  const answer = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      ...headers,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!answer.ok) throw new Error(`HTTP ${answer.status} — ${url}`);
  return answer.text();
}

/**
 * Fetch and parse JSON, not trusting the content type.
 *
 * 일부 API 가 헤더를 틀리게 보낸다.
 *
 * @async
 * @param {string} url - Where to ask.
 * @param {number} timeoutMs - Milliseconds to wait.
 * @param {Record<string, string>} [headers={}] - Extra headers.
 * @returns {Promise<unknown>} The parsed body.
 */
async function getJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> {
  return JSON.parse(await get(url, timeoutMs, headers));
}

/**
 * What to type into a provider's search box.
 *
 * @param {string} title - Song name.
 * @param {string | undefined} artist - Performer, when known.
 * @returns {string} The query, escaped.
 */
function query(title: string, artist: string | undefined): string {
  return encodeURIComponent([title, artist].filter(Boolean).join(" "));
}

// ── 제공처 ────────────────────────────────────────────────────────────────

interface FloArtist {
  name?: string;
}

interface FloTrack {
  id?: number | string;
  name?: string;
  playTime?: string;
  artistList?: FloArtist[];
  lyrics?: string;
  lyricsList?: Array<{ timeMillis?: number; time?: number; text?: string }>;
  /** `imgList` 는 같은 그림의 크기별 주소다 — 75px 부터 1000px 까지 작은 것부터 온다. */
  album?: { title?: string; imgList?: Array<{ url?: string }> };
}

interface VibeArtist {
  artistName?: string;
}

interface VibeTrack {
  trackId?: number | string;
  trackTitle?: string;
  playTime?: string;
  artists?: VibeArtist[];
  album?: { albumTitle?: string; imageUrl?: string };
}

/**
 * Make an address written in a page usable on its own.
 *
 * genie 는 자켓 주소를 `//image.genie.co.kr/…` 꼴로 준다 — 그대로는 못 받으므로 빠진 스킴만
 * 채운다. 크기나 경로는 **건드리지 않는다**: 저쪽이 규칙을 바꾸면 우리가 지어낸 주소만 깨진다.
 *
 * @param {string | undefined} src - The address as the page wrote it.
 * @returns {string | undefined} An address that can be fetched, or undefined when there was none.
 *
 * @example
 * imageAt("//image.genie.co.kr/a.jpg"); // "https://image.genie.co.kr/a.jpg"
 */
function imageAt(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("//")) return `https:${src}`;
  return src.startsWith("http") ? src : undefined;
}

/**
 * Bugs — 트랙 검색 목록에서 고르고 트랙 페이지의 가사 칸을 읽는다.
 *
 * @async
 * @param {string} title - Song name.
 * @param {string} [artist] - Performer.
 * @param {number} [timeoutMs=LYRIC_TIMEOUT_MS] - Milliseconds to wait per request.
 * @returns {Promise<Lyrics | null>} The lyric, or null when this provider does not have it.
 */
export async function bugs(
  title: string,
  artist?: string,
  timeoutMs: number = LYRIC_TIMEOUT_MS,
): Promise<Lyrics | null> {
  const base = "https://music.bugs.co.kr";
  const head = { Referer: `${base}/` };
  const found = parseHtml(await get(`${base}/search/track?q=${query(title, artist)}`, timeoutMs, head));
  const rows: Array<[string, string, string, string | undefined]> = [];
  for (const row of found.find("tr", { attr: "trackid" })) {
    // 제목은 `p.title` **안의** a 다. 행의 첫 a 를 집으면 앨범 표지 링크가 걸린다.
    const holder = row.first("p", { cls: "title" });
    const link = holder === null ? null : holder.first("a");
    const name = (link === null ? "" : link.attrs["title"] ?? "") || textOf(link);
    if (!name.trim()) continue;
    const singer = row.first("p", { cls: "artist" });
    const cover = row.first("img");
    rows.push([
      row.attrs["trackid"] ?? "",
      name.trim(),
      textOf(singer === null ? null : singer.first("a")),
      imageAt(cover === null ? undefined : cover.attrs["src"]),
    ]);
  }
  const best = pickTrack(rows, title, artist, (one) => [one[1], one[2]]);
  if (best === null) return null;

  const trackId = best[0];
  const where = `${base}/track/${trackId}`;
  const page = parseHtml(await get(where, timeoutMs, head));
  const holder = page.first("div", { cls: "lyricsContainer" });
  // `<xmp>` 안에는 줄바꿈이 그대로 있다. 공백을 뭉개면 스물여덟 줄이 한 줄이 된다.
  const plain = holder === null ? null : holder.first("xmp");
  const lyrics = plain === null ? htmlToText(innerHtml(holder)) : plain.rawText().trim();
  if (!lyrics.trim()) return null;
  // 트랙 페이지의 `li.big` 이 200px 자켓이다. 검색 행의 것은 50px 이라 그 다음으로 친다.
  const big = page.first("li", { cls: "big" });
  const cover = big === null ? null : big.first("img");
  return {
    provider: "bugs",
    lyrics: lyrics.trim(),
    title: best[1] || title,
    artist: best[2] || artist,
    imageUrl: imageAt(cover === null ? undefined : cover.attrs["src"]) ?? best[3],
    url: where,
    trackId,
    synced: [],
  };
}

/**
 * Genie — 검색에서 고르고, 시각이 붙은 가사를 `get_msl.asp` 에서 받는다.
 *
 * 19금 곡의 가사는 일반 브라우저에게 안 보여 준다. **가사를 읽을 때만** 크롤러 UA 로 묻는다 —
 * 검색을 그 UA 로 물으면 결과가 비기 때문에 검색은 그대로 둔다.
 *
 * @async
 * @param {string} title - Song name.
 * @param {string} [artist] - Performer.
 * @param {number} [timeoutMs=LYRIC_TIMEOUT_MS] - Milliseconds to wait per request.
 * @returns {Promise<Lyrics | null>} The lyric, or null.
 */
export async function genie(
  title: string,
  artist?: string,
  timeoutMs: number = LYRIC_TIMEOUT_MS,
): Promise<Lyrics | null> {
  const base = "https://www.genie.co.kr";
  const head = { Referer: `${base}/` };
  const found = parseHtml(await get(`${base}/search/searchMain?query=${query(title, artist)}`, timeoutMs, head));
  const rows: Array<[string, string, string, string | undefined, string | undefined]> = [];
  for (const row of found.find("tr", { attr: "songid" })) {
    const link = row.first("a", { cls: "title" });
    const name = link === null ? "" : link.ownText() || (link.attrs["title"] ?? "").trim();
    if (!name) continue;
    // 시각 가사가 있으면 상세 페이지를 안 열므로, 자켓은 **검색 행에서** 챙겨 두어야 한다.
    const cover = row.first("img");
    rows.push([
      row.attrs["songid"] ?? "",
      name,
      textOf(row.first("a", { cls: "artist" })),
      textOf(row.first("a", { cls: "albumtitle" })) || undefined,
      imageAt(cover === null ? undefined : cover.attrs["src"]),
    ]);
  }
  const best = pickTrack(rows, title, artist, (one) => [one[1], one[2]]);
  if (best === null) return null;

  const songId = best[0];
  let synced: LyricLine[] = [];
  let lyrics = "";
  try {
    const raw = await get(
      `https://dn.genie.co.kr/app/purchase/get_msl.asp?path=a&songid=${songId}`,
      timeoutMs,
      head,
    );
    synced = genieMsl(raw);
    if (synced.length > 0 && isTitleHeader(synced[0]!.text, best[1], best[2])) synced = synced.slice(1);
    lyrics = synced.map((one) => one.text).join("\n");
  } catch {
    /* 시각 가사가 없는 곡 — 아래에서 페이지를 읽는다 */
  }

  const detail = `${base}/detail/songInfo?xgnm=${songId}`;
  if (!lyrics.trim()) {
    const page = parseHtml(await get(detail, timeoutMs, { ...head, "User-Agent": CRAWLER_UA }));
    const holder =
      [...page.find("p")].find((one) => inId(page, one, "pLyrics")) ?? page.first("div", { cls: "lyrics" });
    let out = holder === undefined || holder === null ? [] : htmlToText(innerHtml(holder)).split("\n");
    if (out.length > 0 && isTitleHeader(out[0]!, best[1], best[2])) out = out.slice(1);
    lyrics = out.join("\n").trim();
  }
  if (!lyrics.trim()) return null;
  return {
    provider: "genie",
    lyrics: plainFrom(lyrics, synced),
    title: best[1] || title,
    artist: best[2] || artist,
    album: best[3],
    imageUrl: best[4],
    url: detail,
    trackId: songId,
    synced,
  };
}

/**
 * FLO — JSON 검색으로 고르고 트랙 상세의 `lyrics` 를 받는다.
 *
 * 검색은 `keyword` 만 붙여야 결과가 나온다 — 부가 파라미터를 붙이면 빈 결과가 온다.
 *
 * @async
 * @param {string} title - Song name.
 * @param {string} [artist] - Performer.
 * @param {number} [timeoutMs=LYRIC_TIMEOUT_MS] - Milliseconds to wait per request.
 * @returns {Promise<Lyrics | null>} The lyric, or null.
 */
export async function flo(
  title: string,
  artist?: string,
  timeoutMs: number = LYRIC_TIMEOUT_MS,
): Promise<Lyrics | null> {
  const base = "https://www.music-flo.com";
  const head = { Referer: `${base}/`, Accept: "application/json" };
  const found = (await getJson(`${base}/api/search/v2/search?keyword=${query(title, artist)}`, timeoutMs, head)) as {
    data?: { list?: Array<{ type?: string; list?: FloTrack[] }> };
  } | null;
  const groups = found?.data?.list ?? [];
  const group = groups.find((one) => one.type === "TRACK") ?? groups[0] ?? {};
  const best = pickTrack(group.list ?? [], title, artist, (one) => [
    one.name,
    (one.artistList ?? []).map((a) => a.name ?? "").join(", "),
  ]);
  if (best === null) return null;

  const trackId = String(best.id);
  const meta =
    ((await getJson(`${base}/api/meta/v1/track/${trackId}`, timeoutMs, head)) as { data?: FloTrack } | null)?.data ??
    {};
  let synced: LyricLine[] = [];
  if (Array.isArray(meta.lyricsList) && meta.lyricsList.length > 0) {
    synced = meta.lyricsList.map((one) => ({
      timeMs: Math.trunc(Number(one.timeMillis ?? one.time ?? 0)),
      text: one.text ?? "",
    }));
  } else if (meta.lyrics && /\[\d{1,2}:\d{2}/.test(meta.lyrics)) {
    synced = parseLrc(meta.lyrics);
  }

  const plain = (meta.lyrics ?? "").replace(/\[[^\]]*\]/g, "").trim();
  const lyrics = plainFrom(plain, synced);
  if (!lyrics) return null;
  const credited = (best.artistList ?? []).map((one) => one.name ?? "").filter(Boolean);
  // flo 만 크기별 주소를 목록으로 준다. 줄이는 것은 부르는 쪽이 할 수 있고 늘리는 것은 못 하므로
  // 가장 큰 것을 싣는다. 자리로 고르지 않고 **마지막**을 집어 목록이 길어져도 따라간다.
  const art = meta.album?.imgList ?? best.album?.imgList ?? [];
  return {
    provider: "flo",
    lyrics,
    title: meta.name || best.name || title,
    artist: credited.length > 0 ? credited.join(", ") : artist,
    album: meta.album?.title ?? best.album?.title,
    imageUrl: imageAt(art[art.length - 1]?.url),
    durationMs: playTime(best.playTime ?? meta.playTime) ?? undefined,
    url: `${base}/detail/track/${trackId}/detailinfo`,
    trackId,
    synced,
  };
}

/**
 * Vibe (네이버) — JSON 검색으로 고르고 `lyric` 에서 평문과 시각 가사를 받는다.
 *
 * 시각 가사는 **나란한 두 배열**이다: `startTimeIndex[i]`(초, 실수)가 `contents[0].text[i]` 와
 * 짝이다. 예전에는 `lyricLine: [{startTimeMillis, text}]` 였는데 그 모양은 이제 오지 않는다 —
 * `hasSyncLyric` 은 여전히 true 로 오므로 깃발만 보아서는 알 수 없다.
 *
 * @async
 * @param {string} title - Song name.
 * @param {string} [artist] - Performer.
 * @param {number} [timeoutMs=LYRIC_TIMEOUT_MS] - Milliseconds to wait per request.
 * @returns {Promise<Lyrics | null>} The lyric, or null.
 */
export async function vibe(
  title: string,
  artist?: string,
  timeoutMs: number = LYRIC_TIMEOUT_MS,
): Promise<Lyrics | null> {
  const api = "https://apis.naver.com/vibeWeb/musicapiweb";
  const head = { Referer: "https://vibe.naver.com/", Accept: "application/json" };
  const found = (await getJson(
    `${api}/v3/search/track?query=${query(title, artist)}&start=1&display=10&sort=RELEVANCE`,
    timeoutMs,
    head,
  )) as { response?: { result?: { tracks?: VibeTrack[] } } } | null;
  const tracks = found?.response?.result?.tracks ?? [];
  const best = pickTrack(tracks, title, artist, (one) => [
    one.trackTitle,
    (one.artists ?? []).map((a) => a.artistName ?? "").join(", "),
  ]);
  if (best === null) return null;

  const trackId = String(best.trackId);
  const answer = (await getJson(`${api}/v3/lyric/${trackId}`, timeoutMs, head)) as {
    response?: {
      result?: {
        lyric?: {
          normalLyric?: { text?: string };
          syncLyric?: { startTimeIndex?: number[]; contents?: Array<{ languageType?: string; text?: string[] }> };
        };
      };
    };
  } | null;
  const lyric = answer?.response?.result?.lyric ?? {};

  const synced: LyricLine[] = [];
  const sync = lyric.syncLyric ?? {};
  const times = sync.startTimeIndex;
  const contents = sync.contents ?? [];
  // 언어가 여럿일 수 있다. 원문(default)을 쓰고, 없으면 첫 번째를 쓴다.
  const body = (contents.find((one) => one.languageType === "default") ?? contents[0] ?? {}).text;
  if (Array.isArray(times) && Array.isArray(body) && times.length > 0) {
    // 길이가 어긋나면 짧은 쪽까지만. 짝이 없는 시각에는 붙일 글자가 없다.
    const many = Math.min(times.length, body.length);
    for (let k = 0; k < many; k += 1) {
      const text = body[k] ?? "";
      if (!text.trim()) continue;
      synced.push({ timeMs: Math.round(Number(times[k] ?? 0) * 1000), text });
    }
  }

  const lyrics = plainFrom(lyric.normalLyric?.text, synced);
  if (!lyrics) return null;
  const credited = (best.artists ?? []).map((one) => one.artistName ?? "").filter(Boolean);
  return {
    provider: "vibe",
    lyrics,
    title: best.trackTitle || title,
    artist: credited.length > 0 ? credited.join(", ") : artist,
    album: best.album?.albumTitle,
    imageUrl: imageAt(best.album?.imageUrl),
    durationMs: playTime(best.playTime) ?? undefined,
    url: `https://vibe.naver.com/track/${trackId}`,
    trackId,
    synced,
  };
}

/**
 * 제목이 안 맞을 때 「그 근처에 무엇이 있는지」 보여 주려고 그냥 검색만 해 본다.
 *
 * 가사를 고르는 규칙은 제목 일치를 필수로 한다 — 틀린 가사를 받느니 못 받는 편이 낫기 때문이다.
 * 그런데 사람이 철자를 하나 틀린 것뿐일 때 「없다」고만 하면 무엇을 고쳐야 할지 알 수 없다.
 * 이것은 **거르지 않은** 검색 결과다.
 *
 * 앨범·길이·곡 번호도 함께 싣는다. 검색 응답에 이미 들어 있는 값이라 더 물을 것이 없고, 길이가
 * 있어야 이 목록으로 고른 곡의 음원을 길이로 확인할 수 있다.
 *
 * @async
 * @param {string} title - 찾던 곡 이름.
 * @param {string} [artist] - 가수 이름.
 * @param {object} [options={}] - `most` 몇 개까지 볼지, `timeoutMs` 기다릴 밀리초.
 * @returns {Promise<Suggestion[]>} 제목·가수·앨범·길이·곡 번호. 검색이 안 되면 빈 목록.
 *
 * @example
 * await suggest("offically missing you", "긱스");
 * // [{ title: "Officially Missing You", artist: "긱스(Geeks)", durationMs: 253000, … }]
 */
export async function suggest(
  title: string,
  artist?: string,
  options: { most?: number; timeoutMs?: number } = {},
): Promise<Suggestion[]> {
  const most = options.most ?? 8;
  const timeoutMs = options.timeoutMs ?? LYRIC_TIMEOUT_MS;
  // 제목에 오타가 있으면 저쪽 검색도 아무것도 못 준다 — 「offically missing you」로는 0건이다.
  // 그때는 **가수만으로** 다시 묻는다. 그 사람이 부른 곡 목록에 찾던 것이 대개 맨 위에 있다.
  const asks = [query(title, artist), ...(artist ? [query(artist, undefined)] : [])];
  for (const ask of asks) {
    let found: { response?: { result?: { tracks?: VibeTrack[] } } } | null;
    try {
      found = (await getJson(
        `https://apis.naver.com/vibeWeb/musicapiweb/v3/search/track?query=${ask}&start=1&display=${most}&sort=RELEVANCE`,
        timeoutMs,
        { Referer: "https://vibe.naver.com/", Accept: "application/json" },
      )) as { response?: { result?: { tracks?: VibeTrack[] } } } | null;
    } catch {
      continue;
    }
    const tracks = found?.response?.result?.tracks ?? [];
    if (tracks.length > 0) {
      return tracks.slice(0, most).map((one) => {
        const row: Suggestion = {
          title: one.trackTitle ?? "",
          artist: (one.artists ?? []).map((a) => a.artistName ?? "").join(", "),
        };
        const album = one.album?.albumTitle;
        if (album) row.album = album;
        // 주소는 온 그대로 싣는다 — `type=r480Fll` 같은 크기 지정도 손대지 않는다.
        const imageUrl = imageAt(one.album?.imageUrl);
        if (imageUrl !== undefined) row.imageUrl = imageUrl;
        const durationMs = playTime(one.playTime);
        if (durationMs !== null) row.durationMs = durationMs;
        if (one.trackId !== undefined && one.trackId !== null) row.trackId = String(one.trackId);
        return row;
      });
    }
  }
  return [];
}

/** 부르는 순서. 앞의 둘은 JSON API 라 잘 안 깨지므로 먼저 묻는다. */
export const PROVIDERS: Record<string, (title: string, artist?: string, timeoutMs?: number) => Promise<Lyrics | null>> =
  { vibe, flo, genie, bugs };

/**
 * 제공처들에게 가사를 물어 받아 온 것을 모두 돌려준다.
 *
 * 한 곳이 막혀도 나머지로 간다 — 페이지를 읽는 쪽은 저쪽이 화면을 바꾸면 깨지기 때문이다.
 * 여럿을 받아 두면 Mora 에 어느 글을 보낼지 고를 수 있고, 제공처마다 표기가 조금씩 다르므로
 * 가장 잘 맞는 것이 confidence 로 드러난다.
 *
 * @async
 * @param {string} title - 곡 이름.
 * @param {string} [artist] - 가수 이름. 같은 제목의 다른 곡을 가려낸다.
 * @param {FetchOptions} [options={}] - 물어볼 곳·기다릴 시간·하나만 받을지.
 * @returns {Promise<Lyrics[]>} 받아 온 가사들. 하나도 못 받으면 빈 목록.
 *
 * @example
 * const got = await fetchLyrics("영원은 그렇듯", "리도어");
 * console.log(got.map((one) => one.provider)); // ["vibe", "flo", "genie", "bugs"]
 */
export async function fetchLyrics(title: string, artist?: string, options: FetchOptions = {}): Promise<Lyrics[]> {
  const timeoutMs = options.timeoutMs ?? LYRIC_TIMEOUT_MS;
  const out: Lyrics[] = [];
  for (const name of options.providers ?? Object.keys(PROVIDERS)) {
    const provider = PROVIDERS[name];
    if (provider === undefined) continue;
    let got: Lyrics | null;
    try {
      got = await provider(title, artist, timeoutMs);
    } catch {
      continue; // 한 곳이 막힌 것으로 전체를 멈추지 않는다
    }
    if (got !== null && got.lyrics.trim()) {
      out.push(got);
      if (options.first) break;
    }
  }
  return out;
}

// ── 안쪽 ──────────────────────────────────────────────────────────────────

/**
 * Whether a node sits under an element with an id.
 *
 * @param {Node} page - Where to look from.
 * @param {Node} want - The node to place.
 * @param {string} ident - The id of the wrapper.
 * @returns {boolean} True when it does.
 */
function inId(page: Node, want: Node, ident: string): boolean {
  for (const holder of page.find(null, { attr: "id" })) {
    if (holder.attrs["id"] !== ident) continue;
    if (holder === want) return true;
    for (const one of holder.find()) if (one === want) return true;
  }
  return false;
}

/**
 * Read Genie's `{ "400": "line", "12040": "line" }` — the key is the millisecond.
 *
 * @param {string} raw - The JSONP body.
 * @returns {LyricLine[]} Lines in time order.
 *
 * @example
 * genieMsl('lyrics({"400":"첫째"});'); // [{ timeMs: 400, text: "첫째" }]
 */
export function genieMsl(raw: string): LyricLine[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) return [];
  let got: Record<string, unknown>;
  try {
    got = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: LyricLine[] = [];
  for (const [key, text] of Object.entries(got)) {
    const at = Number(key);
    if (!Number.isFinite(at) || !/^-?\d+$/.test(key.trim())) continue;
    out.push({ timeMs: at, text: String(text) });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Whether the first line is really the song's title banner.
 *
 * Genie 는 곡에 따라 가사 맨 앞에 「Half The World Away - Oasis」 같은 줄을 넣는다. 시각 가사에서는
 * 0ms 에 붙어 있어 그대로 두면 정렬이 통째로 한 줄씩 밀린다. 제목(+가수)과 **정확히** 같을 때만
 * 버린다 — 「Swim, swim」처럼 제목으로 시작하는 진짜 첫 소절은 남겨야 한다.
 *
 * @param {string | null | undefined} line - The first line.
 * @param {string} title - The song's title.
 * @param {string | null | undefined} artist - Its artist.
 * @returns {boolean} True when the line is a banner, not singing.
 *
 * @example
 * isTitleHeader("Swim, swim in the dark", "Swim", "BTS"); // false
 */
export function isTitleHeader(
  line: string | null | undefined,
  title: string,
  artist: string | null | undefined,
): boolean {
  if (!line) return false;
  const first = comparable(line);
  if (!first) return false;
  return first === comparable(`${title}${artist ?? ""}`) || first === comparable(title);
}
