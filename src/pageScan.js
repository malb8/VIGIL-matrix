/*
 * Injected into every frame of the active tab by popup.js
 * (chrome.scripting.executeScript with allFrames: true).
 * Must remain a self-contained classic script.
 *
 * v0.8 fixes:
 * - Fonts loaded via CSS @font-face reported initiatorType "css" and were
 *   misclassified as stylesheets. File-extension heuristics now win over
 *   weak initiator types.
 * - "beacon" (navigator.sendBeacon) is mapped into the XHR matrix column,
 *   matching the DNR "ping" resource type the XHR column now governs.
 * - Unknown fetch/other initiators fall back to the XHR column instead of
 *   being dropped, so tracker beacons stay visible in the matrix.
 */
(() => {
  const INITIATOR_MAP = {
    script: "script",
    img: "image",
    image: "image",
    input: "image",
    css: "stylesheet",
    link: "stylesheet",
    fetch: "xmlhttprequest",
    xmlhttprequest: "xmlhttprequest",
    beacon: "xmlhttprequest",
    ping: "xmlhttprequest",
    iframe: "sub_frame",
    frame: "sub_frame",
    font: "font",
    video: "media",
    audio: "media",
    track: "media",
    object: "media",
    embed: "media"
  };

  // Initiator types whose classification is unreliable and should defer to
  // the file extension when one is recognizable.
  const WEAK_INITIATORS = new Set(["css", "link", "fetch", "xmlhttprequest", "other", ""]);

  const EXT_MAP = {
    js: "script", mjs: "script",
    css: "stylesheet",
    woff: "font", woff2: "font", ttf: "font", otf: "font", eot: "font",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
    svg: "image", ico: "image", avif: "image", bmp: "image",
    mp4: "media", webm: "media", ogg: "media", mp3: "media", m4a: "media",
    wav: "media", flac: "media", m3u8: "media", mpd: "media"
  };

  function extensionOf(url) {
    const path = url.pathname || "";
    const dot = path.lastIndexOf(".");
    if (dot === -1 || dot === path.length - 1) return null;
    const ext = path.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
  }

  function classify(url, rawType) {
    const initiator = String(rawType || "").toLowerCase();
    const mapped = INITIATOR_MAP[initiator] || null;
    const ext = extensionOf(url);
    const byExt = ext ? EXT_MAP[ext] || null : null;

    if (byExt && (!mapped || WEAK_INITIATORS.has(initiator))) return byExt;
    if (mapped) return mapped;
    if (byExt) return byExt;
    // fetch()/sendBeacon/unknown network activity belongs in the XHR column.
    return "xmlhttprequest";
  }

  const out = new Map();

  function add(urlLike, rawType, source) {
    try {
      if (!urlLike) return;
      const url = new URL(urlLike, location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      const host = url.hostname.toLowerCase();
      const type = classify(url, rawType);
      const key = `${host}|${type}`;
      if (!out.has(key)) out.set(key, { host, type, count: 0, samples: [], sources: new Set() });
      const item = out.get(key);
      item.count += 1;
      item.sources.add(source || "unknown");
      if (item.samples.length < 3) item.samples.push(url.href.slice(0, 240));
    } catch (_) {}
  }

  for (const entry of performance.getEntriesByType("resource")) {
    add(entry.name, entry.initiatorType, "performance");
  }

  document.querySelectorAll("script[src]").forEach((el) => add(el.src, "script", "dom"));
  document.querySelectorAll("iframe[src], frame[src]").forEach((el) => add(el.src, "iframe", "dom"));
  document.querySelectorAll("img[src]").forEach((el) => add(el.src, "img", "dom"));
  document.querySelectorAll("link[rel~='stylesheet'][href]").forEach((el) => add(el.href, "link", "dom"));
  document.querySelectorAll("video[src], audio[src], source[src]").forEach((el) => add(el.src, "video", "dom"));
  document.querySelectorAll("object[data], embed[src]").forEach((el) => add(el.data || el.src, "object", "dom"));

  return {
    pageUrl: location.href,
    frameHost: location.hostname.toLowerCase(),
    isTop: window === window.top,
    resources: Array.from(out.values())
      .map((item) => ({ ...item, sources: Array.from(item.sources).sort() }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.type.localeCompare(b.type))
  };
})();
