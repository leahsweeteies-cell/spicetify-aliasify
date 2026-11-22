(function coverArtOverride() {
  "use strict";

  if (window.__coverArtOverride) return;
  window.__coverArtOverride = true;

  const CONFIG = {
    playbarButton: true,
    refreshThemeColors: true,
    maxSize: 1024,
    jpegQuality: 0.92,
    maxFileMB: 30,
    rename: true,
    renamePlaybarButton: false,
  };

  const LOG = "[cover-art-override]";
  const DB_NAME = "cover-art-override";
  const STORE = "covers";
  const ATTRS = ["src", "srcset"];
  const RELEASE_URI_RE = /^spotify:(album|track):[0-9A-Za-z]{22}$/;

  const REF_RE = /(?:https?:\/\/[^\s,"'()]+\/image\/|spotify:image:)([0-9a-f]{40})[^\s,"'()]*/gi;

  class UserError extends Error {}

  const records = new Map();
  const keyIndex = new Map();
  const origMap = new WeakMap();
  let useBlobUrls = true;

  const nativeSet = Element.prototype.setAttribute;
  const nativeGet = Element.prototype.getAttribute;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasRef = (s) => s.indexOf("/image/") !== -1 || s.indexOf("spotify:image:") !== -1;

  const keyFor = (hash) => (hash.startsWith("ab67616d") ? "a:" + hash.slice(16) : "h:" + hash);

  function keysFromImages(images) {
    const keys = new Set();
    for (const im of images || []) {
      const m = /\/image\/([0-9a-f]{40})/i.exec((im && im.url) || "");
      if (m) keys.add(keyFor(m[1].toLowerCase()));
    }
    return Array.from(keys);
  }

  function findRecord(keys) {
    for (const k of keys) {
      const rec = keyIndex.get(k);
      if (rec) return rec;
    }
    return null;
  }

  const ONE_RE = /(?:https?:\/\/[^\s,"'()]+\/image\/|spotify:image:)([0-9a-f]{40})/i;

  function recordForText(str) {
    const m = ONE_RE.exec(str || "");
    return m ? keyIndex.get(keyFor(m[1].toLowerCase())) || null : null;
  }

  function reindex() {
    keyIndex.clear();
    for (const rec of records.values()) for (const k of rec.keys) keyIndex.set(k, rec);
  }

  function rewriteText(str) {
    if (!keyIndex.size || !str || !hasRef(str)) return str;
    return str.replace(REF_RE, (match, hash) => {
      const rec = keyIndex.get(keyFor(hash.toLowerCase()));
      return rec ? rec.url : match;
    });
  }

  function remember(el, attr, input, output) {
    let rec = origMap.get(el);
    if (!rec) origMap.set(el, (rec = {}));
    rec[attr] = { input, output };
  }

  function hook(el, attr, value) {
    const s = typeof value === "string" ? value : String(value);
    if (hasRef(s)) {
      const out = rewriteText(s);
      remember(el, attr, s, out);
      return out;
    }
    const rec = origMap.get(el);
    if (rec) delete rec[attr];
    return value;
  }

  function baseOf(el, attr, cur) {
    const rec = origMap.get(el);
    const r = rec && rec[attr];
    return r && (cur === r.output || cur === r.input) ? r.input : cur;
  }

  function syncAttr(el, attr) {
    const cur = nativeGet.call(el, attr);
    if (cur == null) return;
    const base = baseOf(el, attr, cur);
    if (!hasRef(base)) return;
    const next = rewriteText(base);
    if (next !== cur) nativeSet.call(el, attr, next);
    remember(el, attr, base, next);
  }

  function syncEl(el) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === "IMG" || tag === "SOURCE") for (const a of ATTRS) syncAttr(el, a);
    syncAttr(el, "style");
  }

  const SELECTOR = "img, source, [style*='url(']";

  function syncTree(node) {
    if (!node || node.nodeType !== 1) return;
    syncEl(node);
    node.querySelectorAll(SELECTOR).forEach(syncEl);
  }

  function refreshAll() {
    document.querySelectorAll(SELECTOR).forEach(syncEl);
  }

  function patchProp(proto, prop) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(v) {
        d.set.call(this, hook(this, prop, v));
      },
    });
  }

  function installHooks() {
    patchProp(HTMLImageElement.prototype, "src");
    patchProp(HTMLImageElement.prototype, "srcset");
    patchProp(HTMLSourceElement.prototype, "src");
    patchProp(HTMLSourceElement.prototype, "srcset");

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        try {
          if (keyIndex.size) {
            const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
            const url = typeof input === "string" ? input : input && (input.url || String(input));
            if (method === "GET" && url && hasRef(url)) {
              const rec = recordForText(url);
              if (rec && rec.blob) {
                return Promise.resolve(
                  new Response(rec.blob, { status: 200, headers: { "Content-Type": rec.blob.type || "image/jpeg" } })
                );
              }
            }
          }
        } catch (e) {
        }
        return nativeFetch.apply(this, arguments);
      };
    }

    Element.prototype.setAttribute = function (name, value) {
      if (
        (name === "src" || name === "srcset") &&
        (this instanceof HTMLImageElement || this instanceof HTMLSourceElement)
      ) {
        value = hook(this, name, value);
      }
      return nativeSet.call(this, name, value);
    };
  }

  function startObserver() {
    const mo = new MutationObserver((muts) => {
      if (!keyIndex.size) return;
      for (const m of muts) {
        if (m.type === "attributes") syncEl(m.target);
        else m.addedNodes.forEach(syncTree);
      }
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style"],
    });
  }

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function idb(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function detectBlobSupport() {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      const ok = await new Promise((res) => {
        const i = new Image();
        i.onload = () => res(true);
        i.onerror = () => res(false);
        i.src = url;
      });
      URL.revokeObjectURL(url);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function toDisplayUrl(blob) {
    if (useBlobUrls) return Promise.resolve(URL.createObjectURL(blob));
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function revoke(url) {
    if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  async function loadAll() {
    useBlobUrls = await detectBlobSupport();
    let rows = [];
    try {
      rows = (await idb("readonly", (s) => s.getAll())) || [];
    } catch (e) {
      console.warn(LOG, "Couldn't read saved covers", e);
    }
    for (const row of rows) {
      try {
        records.set(row.id, { ...row, url: await toDisplayUrl(row.blob) });
      } catch (e) {
        console.warn(LOG, "Skipping unreadable cover", row.id, e);
      }
    }
    reindex();
    refreshAll();
  }

  async function saveOverride(meta, keys, blob) {
    const row = { id: meta.uri, keys, name: meta.name, artist: meta.artist, blob, savedAt: Date.now() };
    let persisted = true;
    try {
      await idb("readwrite", (s) => s.put(row));
    } catch (e) {
      persisted = false;
      console.warn(LOG, "Couldn't persist cover", e);
    }

    const stale = [];
    for (const rec of Array.from(records.values())) {
      if (rec.id !== row.id && rec.keys.some((k) => keys.includes(k))) {
        records.delete(rec.id);
        stale.push(rec.url);
        try {
          await idb("readwrite", (s) => s.delete(rec.id));
        } catch (e) {
        }
      }
    }
    const prev = records.get(row.id);
    if (prev) stale.push(prev.url);

    records.set(row.id, { ...row, url: await toDisplayUrl(blob) });
    reindex();
    refreshAll();
    setTimeout(() => stale.forEach(revoke), 3000);
    return { persisted };
  }

  async function restoreOverride(rec) {
    try {
      await idb("readwrite", (s) => s.delete(rec.id));
    } catch (e) {
      console.warn(LOG, "Couldn't delete stored cover", e);
    }
    records.delete(rec.id);
    reindex();
    refreshAll();
    setTimeout(() => revoke(rec.url), 3000);
  }

  async function toSquareJpeg(file) {
    if (!file || (file.type && !file.type.startsWith("image/"))) {
      throw new UserError("That file isn\u2019t an image.");
    }
    if (file.size > CONFIG.maxFileMB * 1048576) {
      throw new UserError("That image is too large (max " + CONFIG.maxFileMB + " MB).");
    }
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      throw new UserError("Couldn\u2019t read that image. Try a PNG, JPEG or WebP.");
    }
    try {
      const side = Math.min(bmp.width, bmp.height);
      if (side < 100) throw new UserError("That image is too small.");
      const out = Math.min(side, CONFIG.maxSize);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = out;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, out, out);
      ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", CONFIG.jpegQuality));
      if (!blob) throw new UserError("Couldn\u2019t process that image.");
      return blob;
    } finally {
      if (bmp.close) bmp.close();
    }
  }

  const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function idToGid(id) {
    let n = BigInt(0);
    for (const ch of id) n = n * BigInt(62) + BigInt(B62.indexOf(ch));
    return n.toString(16).padStart(32, "0");
  }

  function gidToId(gid) {
    let n = BigInt("0x" + gid);
    let out = "";
    while (n > BigInt(0)) {
      out = B62[Number(n % BigInt(62))] + out;
      n = n / BigInt(62);
    }
    return out.padStart(22, "0");
  }

  const toHttps = (u) => String(u || "").replace("spotify:image:", "https://i.scdn.co/image/");

  async function viaWebApi(type, id) {
    const data = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/" + type + "s/" + id);
    if (!data || data.error) throw new Error("Web API: " + JSON.stringify(data && data.error));
    const album = type === "track" ? data.album : data;
    if (!album || !album.uri || !(album.images || []).length) throw new Error("Web API: no album/images");
    return {
      uri: album.uri,
      name: album.name,
      artist: (album.artists || []).map((a) => a.name).join(", "),
      type: album.album_type,
      images: album.images,
    };
  }

  async function viaGraphQL(type, uri) {
    const G = Spicetify.GraphQL;
    if (!G || !G.Request || !G.Definitions) throw new Error("GraphQL: unavailable");
    const locale = (Spicetify.Locale && Spicetify.Locale.getLocale && Spicetify.Locale.getLocale()) || "en";
    let album;
    if (type === "album") {
      const res = await G.Request(G.Definitions.getAlbum, { uri, locale, offset: 0, limit: 1 });
      album = res && res.data && res.data.albumUnion;
    } else {
      const res = await G.Request(G.Definitions.getTrack, { uri });
      const t = res && res.data && res.data.trackUnion;
      album = t && t.albumOfTrack;
    }
    const sources = album && album.coverArt && album.coverArt.sources;
    if (!album || !album.uri || !sources || !sources.length) throw new Error("GraphQL: no album/images");
    const artists = (album.artists && album.artists.items) || [];
    return {
      uri: album.uri,
      name: album.name,
      artist: artists.map((a) => a.profile && a.profile.name).filter(Boolean).join(", "),
      type: String(album.type || "album").toLowerCase(),
      images: sources
        .slice()
        .sort((a, b) => (b.width || 0) - (a.width || 0))
        .map((i) => ({ url: toHttps(i.url) })),
    };
  }

  async function viaMetadata(type, id, base) {
    const gid = idToGid(id);
    const data = await Spicetify.CosmosAsync.get(base + type + "/" + gid);
    const album = type === "track" ? data && data.album : data;
    const imgs = album && album.cover_group && album.cover_group.image;
    if (!album || !album.gid || !imgs || !imgs.length) throw new Error("Metadata: no album/images");
    return {
      uri: "spotify:album:" + gidToId(album.gid),
      name: album.name,
      artist: (album.artist || []).map((a) => a.name).join(", "),
      type: String(album.type || "album").toLowerCase(),
      images: imgs
        .slice()
        .sort((a, b) => (b.width || 0) - (a.width || 0))
        .map((i) => ({ url: "https://i.scdn.co/image/" + i.file_id })),
    };
  }

  function viaPlayer(uri) {
    const item = Spicetify.Player.data && (Spicetify.Player.data.item || Spicetify.Player.data.track);
    if (!item || item.uri !== uri || !item.album || !item.album.uri) throw new Error("Player: not the playing track");
    const imgs = (item.album.images || []).map((i) => ({ url: toHttps(i.url) }));
    if (!imgs.length) throw new Error("Player: no images");
    return {
      uri: item.album.uri,
      name: item.album.name,
      artist: (item.artists || []).map((a) => a.name).join(", "),
      type: "album",
      images: imgs,
    };
  }

  async function resolveRelease(uri) {
    const parts = uri.split(":");
    const type = parts[1];
    const id = parts[2];
    const errors = [];
    const attempts = [
      () => viaWebApi(type, id),
      () => viaGraphQL(type, uri),
      () => viaMetadata(type, id, "https://spclient.wg.spotify.com/metadata/4/"),
      () => viaMetadata(type, id, "sp://metadata/4/"),
      () => viaPlayer(uri),
    ];
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (e) {
        errors.push(e);
      }
    }
    console.error(LOG, "All lookups failed for", uri, errors);
    throw errors[0];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToHex(h, s, l) {
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, "0");
    };
    return "#" + f(0) + f(8) + f(4);
  }

  async function extractColors(blob) {
    const bmp = await createImageBitmap(blob);
    const S = 48;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, S, S);
    if (bmp.close) bmp.close();
    const px = ctx.getImageData(0, 0, S, S).data;

    const BINS = 24;
    const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let tr = 0, tg = 0, tb = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      tr += r; tg += g; tb += b; n++;
      const hsl = rgbToHsl(r, g, b);
      const w = hsl[1] * (1 - Math.abs(2 * hsl[2] - 1));
      if (w < 0.02) continue;
      const bin = bins[Math.min(BINS - 1, Math.floor(hsl[0] * BINS))];
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
    let best = null;
    for (const bin of bins) if (!best || bin.w > best.w) best = bin;
    let rgb;
    if (best && best.w > 2) rgb = [best.r / best.w, best.g / best.w, best.b / best.w];
    else if (n) rgb = [tr / n, tg / n, tb / n];
    else rgb = [128, 128, 128];

    const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const mk = (hex) => ({ isFallback: false, hex });
    return {
      colorRaw: mk(hslToHex(hsl[0], hsl[1], hsl[2])),
      colorLight: mk(hslToHex(hsl[0], hsl[1], Math.min(0.9, hsl[2] + 0.3))),
      colorDark: mk(hslToHex(hsl[0], hsl[1], Math.max(0.12, hsl[2] * 0.45))),
      desaturated: hslToHex(hsl[0], hsl[1] * 0.35, hsl[2]),
    };
  }

  async function colorsFor(rec) {
    if (!rec.colors) rec.colors = await extractColors(rec.blob);
    return rec.colors;
  }

  function hookGraphQL() {
    const G = window.Spicetify && Spicetify.GraphQL;
    if (!G || typeof G.Request !== "function" || !G.Definitions) return false;
    if (G.Request.__aao) return true;
    const orig = G.Request;
    const wrapped = async function (def, vars) {
      try {
        const def0 = G.Definitions.fetchExtractedColors;
        if (def0 && def === def0 && vars && Array.isArray(vars.imageUris) && keyIndex.size) {
          const recs = vars.imageUris.map((u) => recordForText(String(u)));
          if (recs.some(Boolean)) {
            const others = vars.imageUris.filter((_, i) => !recs[i]);
            let res = null;
            if (others.length) {
              const args = Array.prototype.slice.call(arguments);
              args[1] = Object.assign({}, vars, { imageUris: others });
              res = await orig.apply(this, args);
            }
            const origEntries = (res && res.data && res.data.extractedColors) || [];
            let j = 0;
            const entries = [];
            for (let i = 0; i < recs.length; i++) entries.push(recs[i] ? await colorsFor(recs[i]) : origEntries[j++]);
            return Object.assign({}, res || {}, { data: Object.assign({}, (res && res.data) || {}, { extractedColors: entries }) });
          }
        }
      } catch (e) {
        console.warn(LOG, "Colour override failed, using Spotify\u2019s colours", e);
      }
      return orig.apply(this, arguments);
    };
    wrapped.__aao = true;
    try {
      G.Request = wrapped;
    } catch (e) {
    }
    return G.Request === wrapped;
  }

  const uriKeys = new Map();

  function playingItem() {
    let item = Spicetify.Player.data && (Spicetify.Player.data.item || Spicetify.Player.data.track);
    if (!item) {
      const api = Spicetify.Platform && Spicetify.Platform.PlayerAPI;
      item = api && api.getState && api.getState() && api.getState().item;
    }
    return item || null;
  }

  function itemKeys(item) {
    const urls = [];
    const meta = item.metadata || {};
    for (const k in meta) if (/image/i.test(k) && typeof meta[k] === "string") urls.push(meta[k]);
    for (const im of (item.album && item.album.images) || []) urls.push(im && im.url);
    const keys = new Set();
    for (const u of urls) {
      const m = /([0-9a-f]{40})/i.exec(u || "");
      if (m) keys.add(keyFor(m[1].toLowerCase()));
    }
    return Array.from(keys);
  }

  async function recordForUri(uri) {
    const direct = recordForText(uri);
    if (direct) return direct;
    if (!/^spotify:track:/.test(uri)) return null;
    const item = playingItem();
    if (item && item.uri === uri) return findRecord(itemKeys(item));
    let keys = uriKeys.get(uri);
    if (!keys) {
      keys = keysFromImages((await resolveRelease(uri)).images);
      uriKeys.set(uri, keys);
    }
    return findRecord(keys);
  }

  function paletteFrom(c) {
    return {
      PROMINENT: c.colorRaw.hex,
      VIBRANT: c.colorRaw.hex,
      VIBRANT_NON_ALARMING: c.colorRaw.hex,
      LIGHT_VIBRANT: c.colorLight.hex,
      DARK_VIBRANT: c.colorDark.hex,
      DESATURATED: c.desaturated,
    };
  }

  function hookColorExtractor() {
    if (typeof Spicetify.colorExtractor !== "function") return false;
    if (Spicetify.colorExtractor.__aao) return true;
    const orig = Spicetify.colorExtractor;
    const wrapped = async function (uri) {
      try {
        if (keyIndex.size && typeof uri === "string") {
          const rec = await recordForUri(uri);
          if (rec) {
            console.info(LOG, "using custom colours for", uri);
            return paletteFrom(await colorsFor(rec));
          }
        }
      } catch (e) {
        console.warn(LOG, "Colour override failed, using Spotify\u2019s colours", e);
      }
      return orig.apply(this, arguments);
    };
    wrapped.__aao = true;
    try {
      Spicetify.colorExtractor = wrapped;
    } catch (e) {
    }
    return Spicetify.colorExtractor === wrapped;
  }

  async function waitForColorHooks() {
    let gql = false;
    let extractor = false;
    for (let i = 0; i < 120 && !(gql && extractor); i++) {
      if (window.Spicetify) {
        if (!gql) gql = hookGraphQL();
        if (!extractor) extractor = hookColorExtractor();
      }
      if (!(gql && extractor)) await sleep(250);
    }
    console.info(LOG, "ready (v4)", { graphqlColours: gql, colorExtractor: extractor });
    return gql || extractor;
  }

  const notify = (msg, isError) => Spicetify.showNotification(msg, !!isError);

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureStyle() {
    if (document.getElementById("aao-style")) return;
    const s = document.createElement("style");
    s.id = "aao-style";
    s.textContent = `
.aao{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;color:var(--spice-text,#fff);font-family:inherit}
.aao *{box-sizing:border-box}
.aao-art{position:relative;flex:0 0 192px;width:192px;height:192px;border-radius:4px;overflow:hidden;background:var(--spice-card,#282828);box-shadow:0 4px 60px rgba(0,0,0,.5);cursor:pointer;outline:none}
.aao-art img{display:block;width:100%;height:100%;object-fit:cover}
.aao-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,.72);color:#fff;font-size:14px;font-weight:700;opacity:0;transition:opacity .15s ease}
.aao-art:hover .aao-overlay,.aao-art:focus-visible .aao-overlay,.aao-art.aao-drag .aao-overlay{opacity:1}
.aao-art:focus-visible{box-shadow:0 0 0 2px var(--spice-text,#fff)}
.aao-art.aao-drag{box-shadow:0 0 0 2px var(--spice-button,#1ed760)}
.aao-side{flex:1 1 220px;min-width:0;min-height:192px;display:flex;flex-direction:column}
.aao-title{font-size:22px;font-weight:700;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.aao-sub{margin-top:4px;font-size:14px;color:var(--spice-subtext,#b3b3b3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aao-hint{margin:16px 0 0;font-size:13px;line-height:1.5;color:var(--spice-subtext,#b3b3b3)}
.aao-status{min-height:20px;margin-top:8px;font-size:13px;color:var(--spice-subtext,#b3b3b3)}
.aao-status.aao-error{color:var(--spice-notification-error,#f3727f)}
.aao-actions{margin-top:auto;padding-top:16px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.aao-btn{appearance:none;border:0;border-radius:500px;padding:8px 32px;font-family:inherit;font-size:14px;font-weight:700;line-height:24px;cursor:pointer;transition:transform .1s ease,opacity .15s ease,box-shadow .15s ease}
.aao-btn[hidden]{display:none}
.aao-btn:hover:not(:disabled){transform:scale(1.04)}
.aao-btn:active:not(:disabled){transform:scale(1)}
.aao-btn:disabled{opacity:.4;cursor:default}
.aao-btn:focus-visible{outline:2px solid var(--spice-text,#fff);outline-offset:2px}
.aao-btn-primary{background:var(--spice-text,#fff);color:var(--spice-main,#121212)}
.aao-btn-secondary{background:transparent;color:var(--spice-text,#fff);box-shadow:inset 0 0 0 1px var(--spice-subtext,#7c7c7c)}
.aao-btn-secondary:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--spice-text,#fff)}
`;
    document.head.appendChild(s);
  }

  function pencilSvg() {
    const inner =
      Spicetify.SVGIcons && Spicetify.SVGIcons.edit
        ? Spicetify.SVGIcons.edit
        : '<path d="M11.5 1.5l3 3L5 14H2v-3z"/>';
    return '<svg role="img" aria-hidden="true" width="24" height="24" viewBox="0 0 16 16" fill="currentColor">' + inner + "</svg>";
  }

  function typeLabel(t) {
    if (t === "single") return "Single / EP";
    if (t === "compilation") return "Compilation";
    return "Album";
  }

  function firstImage(files) {
    return Array.from(files || []).find((f) => /^image\//.test(f.type));
  }

  function refreshThemeColors(keys) {
    if (!CONFIG.refreshThemeColors) return;
    try {
      let item = Spicetify.Player.data && (Spicetify.Player.data.item || Spicetify.Player.data.track);
      if (!item) {
        const api = Spicetify.Platform && Spicetify.Platform.PlayerAPI;
        item = api && api.getState && api.getState() && api.getState().item;
      }
      if (!item) return;
      const urls = [];
      const meta = item.metadata || {};
      for (const k in meta) if (/image/i.test(k) && typeof meta[k] === "string") urls.push(meta[k]);
      for (const im of (item.album && item.album.images) || []) urls.push(im && im.url);
      const playing = urls.some((u) => {
        const m = /([0-9a-f]{40})/i.exec(u || "");
        return m && keys.indexOf(keyFor(m[1].toLowerCase())) !== -1;
      });
      if (!playing) return;
      setTimeout(() => {
        try {
          const lm = window.LiquidMusic;
          if (lm && typeof lm.refresh === "function") lm.refresh();
          else Spicetify.Player.dispatchEvent(new Event("songchange"));
        } catch (e) {
          console.warn(LOG, "Couldn't refresh theme colours", e);
        }
      }, 300);
    } catch (e) {
      console.warn(LOG, "Couldn't refresh theme colours", e);
    }
  }

  function openEditor(meta) {
    const keys = keysFromImages(meta.images);
    if (!keys.length) {
      notify("This release has no artwork to replace.", true);
      return;
    }
    ensureStyle();

    const current = findRecord(keys);
    let pending = null;

    const root = h("div", "aao");

    const art = h("div", "aao-art");
    art.tabIndex = 0;
    art.setAttribute("role", "button");
    art.setAttribute("aria-label", "Choose photo");
    const img = h("img");
    img.alt = "";
    img.draggable = false;
    img.src = meta.images[0].url;
    const overlay = h("div", "aao-overlay");
    overlay.innerHTML = pencilSvg();
    overlay.appendChild(h("span", null, "Choose photo"));
    art.append(img, overlay);

    const side = h("div", "aao-side");
    const title = h("div", "aao-title", meta.name);
    const sub = h("div", "aao-sub", [typeLabel(meta.type), meta.artist].filter(Boolean).join(" \u2022 "));
    const hint = h(
      "p",
      "aao-hint",
      "Click the cover, drop an image on it or paste one. It\u2019s cropped to a square and replaces this release\u2019s artwork everywhere in Spotify."
    );
    const status = h("div", "aao-status", current ? "Using a custom cover." : "");
    const actions = h("div", "aao-actions");
    const restore = h("button", "aao-btn aao-btn-secondary", "Restore original");
    restore.type = "button";
    restore.hidden = !current;
    const save = h("button", "aao-btn aao-btn-primary", "Save");
    save.type = "button";
    save.disabled = true;
    actions.append(restore, save);
    side.append(title, sub, hint, status, actions);

    const input = h("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;

    root.append(art, side, input);

    const setStatus = (msg, isError) => {
      status.textContent = msg || "";
      status.classList.toggle("aao-error", !!isError);
    };

    async function pick(file) {
      if (!file) return;
      try {
        setStatus("Processing\u2026");
        const blob = await toSquareJpeg(file);
        const url = await toDisplayUrl(blob);
        if (pending) revoke(pending.url);
        pending = { blob, url };
        img.src = url;
        save.disabled = false;
        setStatus("Ready to save.");
      } catch (e) {
        if (!(e instanceof UserError)) console.error(LOG, e);
        setStatus(e instanceof UserError ? e.message : "Couldn\u2019t process that image.", true);
      }
    }

    art.addEventListener("click", () => input.click());
    art.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.value = "";
      pick(f);
    });

    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") !== -1;
    ["dragenter", "dragover"].forEach((t) =>
      root.addEventListener(t, (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        art.classList.add("aao-drag");
      })
    );
    root.addEventListener("dragleave", (e) => {
      if (!root.contains(e.relatedTarget)) art.classList.remove("aao-drag");
    });
    root.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      art.classList.remove("aao-drag");
      const f = firstImage(e.dataTransfer.files);
      if (f) pick(f);
      else setStatus("Drop an image file.", true);
    });

    const onPaste = (e) => {
      if (!root.isConnected) return;
      const f = firstImage(e.clipboardData && e.clipboardData.files);
      if (f) {
        e.preventDefault();
        pick(f);
      }
    };
    document.addEventListener("paste", onPaste);

    save.addEventListener("click", async () => {
      if (!pending) return;
      save.disabled = true;
      restore.disabled = true;
      setStatus("Saving\u2026");
      try {
        const res = await saveOverride(meta, keys, pending.blob);
        Spicetify.PopupModal.hide();
        refreshThemeColors(keys);
        if (res.persisted) notify("Cover art updated");
        else notify("Cover art updated for this session only", true);
      } catch (e) {
        console.error(LOG, e);
        setStatus("Couldn\u2019t save that image.", true);
        save.disabled = false;
        restore.disabled = false;
      }
    });

    restore.addEventListener("click", async () => {
      restore.disabled = true;
      save.disabled = true;
      try {
        await restoreOverride(current);
        Spicetify.PopupModal.hide();
        refreshThemeColors(keys);
        notify("Original cover restored");
      } catch (e) {
        console.error(LOG, e);
        setStatus("Couldn\u2019t restore the original.", true);
        restore.disabled = false;
        save.disabled = !pending;
      }
    });

    let seen = false;
    const startedAt = Date.now();
    const closeObserver = new MutationObserver(() => {
      if (root.isConnected) {
        seen = true;
        return;
      }
      if (seen || Date.now() - startedAt > 5000) {
        closeObserver.disconnect();
        document.removeEventListener("paste", onPaste);
        if (pending) revoke(pending.url);
      }
    });
    closeObserver.observe(document.body, { childList: true, subtree: true });

    Spicetify.PopupModal.display({ title: "Change cover art", content: root });
  }

  let loading = false;
  async function editRelease(uri) {
    if (loading) return;
    loading = true;
    try {
      openEditor(await resolveRelease(uri));
    } catch (e) {
      console.error(LOG, e);
      notify("Couldn\u2019t load that release\u2019s artwork.", true);
    } finally {
      loading = false;
    }
  }

  const NAMES_KEY = "cover-art-override:names:v1";
  const NAME_MAX = 200;
  const ORIG_MAX = 400;
  const TEXT_ATTRS = ["aria-label", "title", "alt"];
  const TEXT_ATTR_SEL = "[aria-label],[title],[alt]";

  const SKIP_SEL = "[data-aao-skip],script,style,textarea,noscript,[contenteditable='true']";
  const PLAYBACK_SEL = [
    "[data-testid='now-playing-widget']",
    "[data-testid='context-item-info-title']",
    "[data-testid='context-item-link']",
    "[data-testid='NPV_Panel_OpenDiv']",
    ".main-nowPlayingWidget-nowPlaying",
    ".main-trackInfo-container",
    ".main-nowPlayingBar-container",
    ".Root__now-playing-bar",
    ".npv-main-container",
  ].join(",");
  const ROW_SEL = "[role='row'],[data-testid='tracklist-row'],.main-trackList-trackListRow";
  const NOT_TITLE_SEL =
    "[aria-colindex='1'],[role='columnheader'],.main-trackList-rowSectionIndex,.main-trackList-trackListHeaderRow";
  const HEAD_SEL = "h1,[data-testid='entityTitle'],.main-entityHeader-title";
  const SECONDARY_SEL = ".Root__nav-bar,.Root__right-sidebar,.Root__now-playing-bar,aside,nav,footer";

  const names = new Map();
  const origIndex = new Map();
  const textOrig = new WeakMap();
  const attrOrig = new WeakMap();

  const norm = (s) => (s.normalize ? s.normalize("NFC") : s);
  const isTrackUri = (u) => u.startsWith("spotify:track:");

  function reindexNames() {
    origIndex.clear();
    for (const rec of names.values()) {
      const k = norm(rec.orig);
      const list = origIndex.get(k);
      if (list) list.push(rec);
      else origIndex.set(k, [rec]);
    }
  }

  function loadNames() {
    names.clear();
    try {
      const raw = window.localStorage.getItem(NAMES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        for (const r of arr.slice(0, 5000)) {
          if (
            r &&
            typeof r.uri === "string" &&
            RELEASE_URI_RE.test(r.uri) &&
            typeof r.orig === "string" &&
            typeof r.name === "string" &&
            r.orig.trim() &&
            r.name.trim() &&
            r.orig.length <= ORIG_MAX
          ) {
            names.set(r.uri, {
              uri: r.uri,
              type: r.uri.split(":")[1],
              orig: r.orig.trim(),
              name: r.name,
              albumUri: typeof r.albumUri === "string" && RELEASE_URI_RE.test(r.albumUri) ? r.albumUri : null,
              savedAt: Number(r.savedAt) || 0,
            });
          }
        }
      }
    } catch (e) {
      console.warn(LOG, "Couldn't read saved names", e);
    }
    reindexNames();
  }

  function persistNames() {
    try {
      window.localStorage.setItem(NAMES_KEY, JSON.stringify(Array.from(names.values())));
      return true;
    } catch (e) {
      console.warn(LOG, "Couldn't persist names", e);
      return false;
    }
  }

  function entityFromHref(href) {
    if (!href) return null;
    const hl = /[?&]highlight=spotify:track:([0-9A-Za-z]{22})(?![0-9A-Za-z])/.exec(href);
    if (hl) return "spotify:track:" + hl[1];
    let m = /^(?:https?:\/\/open\.spotify\.com)?\/(?:intl-[a-z-]+\/)?(album|track)\/([0-9A-Za-z]{22})(?![0-9A-Za-z])/.exec(href);
    if (m) return "spotify:" + m[1] + ":" + m[2];
    m = /^spotify:(album|track):([0-9A-Za-z]{22})$/.exec(href);
    return m ? m[0] : null;
  }

  function currentTrackUri() {
    try {
      const it = playingItem();
      return it && typeof it.uri === "string" && RELEASE_URI_RE.test(it.uri) ? it.uri : null;
    } catch (e) {
      return null;
    }
  }

  function routePage() {
    try {
      const H = Spicetify.Platform && Spicetify.Platform.History;
      const p = (H && H.location && H.location.pathname) || "";
      const m = /^\/(?:intl-[a-z-]+\/)?(album|track)\/([0-9A-Za-z]{22})/.exec(p);
      return m ? { type: m[1], uri: "spotify:" + m[1] + ":" + m[2] } : null;
    } catch (e) {
      return null;
    }
  }

  function routeTracks() {
    const r = routePage();
    if (!r) return [];
    if (r.type === "track") return [r.uri];
    const out = [];
    for (const rec of names.values()) if (rec.type === "track" && rec.albumUri === r.uri) out.push(rec.uri);
    return out;
  }

  let fiberKey = null;
  function fiberOf(el) {
    for (let n = el, hops = 0; n && hops < 4; n = n.parentElement, hops++) {
      if (!fiberKey || !(fiberKey in n)) {
        const k = Object.keys(n).find((x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"));
        if (!k) continue;
        fiberKey = k;
      }
      if (n[fiberKey]) return n[fiberKey];
    }
    return null;
  }

  function fiberUris(el) {
    const out = [];
    const push = (v) => {
      if (typeof v === "string" && RELEASE_URI_RE.test(v) && out.indexOf(v) === -1) out.push(v);
    };
    const scan = (p) => {
      if (!p || typeof p !== "object") return;
      push(p.uri);
      push(p.trackUri);
      push(p.albumUri);
      for (const k of ["track", "item", "album", "data"]) if (p[k] && typeof p[k] === "object") push(p[k].uri);
      const c = p.children;
      if (c && typeof c === "object" && !Array.isArray(c) && c.props && typeof c.props === "object") {
        push(c.props.uri);
        push(c.props.trackUri);
      }
    };
    let f = fiberOf(el);
    for (let i = 0; f && i < 16; i++, f = f.return) scan(f.memoizedProps);
    return out;
  }

  function lcaUris(el) {
    let p = el;
    for (let i = 0; i < 3 && p && p !== document.body; i++, p = p.parentElement) {
      const byType = {};
      const links = p.querySelectorAll("a[href]");
      for (let j = 0; j < links.length && j < 60; j++) {
        const e = entityFromHref(links[j].getAttribute("href"));
        if (e) (byType[e.split(":")[1]] = byType[e.split(":")[1]] || new Set()).add(e);
      }
      const sets = Object.keys(byType).map((k) => byType[k]);
      if (!sets.length) continue;
      const out = [];
      for (const s of sets) {
        if (s.size > 1) return [];
        s.forEach((u) => out.push(u));
      }
      return out;
    }
    return [];
  }

  function claimUris(el) {
    try {
      if (!el || el.closest(SKIP_SEL)) return [];
      if (el.closest(PLAYBACK_SEL)) {
        const u = currentTrackUri();
        return u ? [u] : [];
      }
      const a = el.closest("a[href]");
      if (a) {
        const e = entityFromHref(a.getAttribute("href"));
        return e ? [e] : [];
      }
      if (el.closest(NOT_TITLE_SEL)) return [];
      const secondary = !!el.closest(SECONDARY_SEL);
      if (el.closest(ROW_SEL)) {
        const t = fiberUris(el).filter(isTrackUri);
        if (t.length) return t;
        return secondary ? [] : routeTracks();
      }
      if (!secondary && el.closest(HEAD_SEL)) {
        const r = routePage();
        if (r) return [r.uri];
      }
      const f = fiberUris(el);
      if (f.length) return f;
      return lcaUris(el);
    } catch (e) {
      return [];
    }
  }

  function renameTextNode(node) {
    const had = textOrig.has(node);
    if (!names.size && !had) return;
    const cur = node.data;
    const r = had ? textOrig.get(node) : null;
    const base = r && cur === r.output ? r.input : cur;
    let target = base;
    if (names.size && base.length <= ORIG_MAX) {
      const t = base.trim();
      const recs = t ? origIndex.get(norm(t)) : null;
      if (recs) {
        const uris = claimUris(node.parentElement);
        for (const u of uris) {
          const rec = recs.find((x) => x.uri === u);
          if (rec) {
            target = base.replace(t, () => rec.name);
            break;
          }
        }
      }
    }
    if (target !== cur) node.data = target;
    if (target !== base) textOrig.set(node, { input: base, output: target });
    else if (had) textOrig.delete(node);
  }

  function replaceName(s, orig, name) {
    if (s === orig) return name;
    try {
      const esc = orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return s.replace(new RegExp("(?<![\\p{L}\\p{N}])" + esc + "(?![\\p{L}\\p{N}])", "gu"), () => name);
    } catch (e) {
      return s.split(orig).join(name);
    }
  }

  function renameAttr(el, attr) {
    const cur = nativeGet.call(el, attr);
    if (cur == null) return;
    const slot = attrOrig.get(el);
    const r = slot && slot[attr];
    const base = r && cur === r.output ? r.input : cur;
    let target = base;
    if (names.size && base.length <= 600) {
      const hits = [];
      for (const rec of names.values()) if (base.indexOf(rec.orig) !== -1) hits.push(rec);
      if (hits.length) {
        const uris = claimUris(el);
        for (const u of uris) {
          const rec = hits.find((x) => x.uri === u);
          if (rec) {
            target = replaceName(base, rec.orig, rec.name);
            break;
          }
        }
      }
    }
    if (target !== cur) nativeSet.call(el, attr, target);
    if (target !== base) {
      const s = slot || {};
      s[attr] = { input: base, output: target };
      if (!slot) attrOrig.set(el, s);
    } else if (r) {
      delete slot[attr];
    }
  }

  function renameAttrs(el) {
    for (const a of TEXT_ATTRS) if (nativeGet.call(el, a) != null) renameAttr(el, a);
  }

  function processTree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      renameTextNode(root);
      return;
    }
    if (root.nodeType !== 1) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) renameTextNode(n);
    renameAttrs(root);
    root.querySelectorAll(TEXT_ATTR_SEL).forEach(renameAttrs);
  }

  function rescanAll() {
    if (document.body) processTree(document.body);
  }

  function onNameMutations(muts) {
    if (!names.size) return;
    for (const m of muts) {
      try {
        if (m.type === "characterData") {
          if (m.target.isConnected) renameTextNode(m.target);
        } else if (m.type === "attributes") {
          if (m.target.isConnected) renameAttr(m.target, m.attributeName);
        } else {
          m.addedNodes.forEach((n) => {
            if (n.isConnected) processTree(n);
          });
        }
      } catch (e) {
        console.warn(LOG, "rename pass failed", e);
      }
    }
  }

  function refreshPlayback() {
    if (!names.size) return;
    try {
      document.querySelectorAll(PLAYBACK_SEL).forEach(processTree);
    } catch (e) {
      console.warn(LOG, "playback refresh failed", e);
    }
  }

  async function hookPlayerEvents() {
    for (let i = 0; i < 240; i++) {
      if (window.Spicetify && Spicetify.Player && typeof Spicetify.Player.addEventListener === "function") {
        Spicetify.Player.addEventListener("songchange", () => {
          setTimeout(refreshPlayback, 80);
          setTimeout(refreshPlayback, 700);
        });
        return;
      }
      await sleep(250);
    }
  }

  function startRename() {
    try {
      loadNames();
      new MutationObserver(onNameMutations).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: TEXT_ATTRS,
      });
      if (names.size) rescanAll();
      hookPlayerEvents().catch((e) => console.error(LOG, e));
    } catch (e) {
      console.error(LOG, "rename feature disabled", e);
    }
  }

  window.__coverArtOverrideRenameCheck = function () {
    const out = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const t = n.data.trim();
      const recs = t ? origIndex.get(norm(t)) : null;
      const el = n.parentElement;
      if (recs && el && !textOrig.has(n) && !el.closest("[data-aao-skip]")) {
        out.push({ text: t, renamedUris: recs.map((r) => r.uri), claims: claimUris(el), element: el });
      }
    }
    console.log(LOG, "occurrences of renamed originals that were left alone:", out);
    return out;
  };

  const trackOf = (uri, name, num) => ({ uri, name: String(name || "").trim(), num: num || 0 });

  async function tracksViaWebApi(albumUri) {
    const id = albumUri.split(":")[2];
    const out = [];
    let url = "https://api.spotify.com/v1/albums/" + id + "/tracks?limit=50&offset=0";
    for (let page = 0; url && page < 20; page++) {
      const data = await Spicetify.CosmosAsync.get(url);
      if (!data || data.error || !Array.isArray(data.items)) throw new Error("Web API: no tracks");
      for (const t of data.items) if (t && t.uri) out.push(trackOf(t.uri, t.name, t.track_number));
      url = data.next || null;
    }
    return out;
  }

  async function tracksViaGraphQL(albumUri) {
    const G = Spicetify.GraphQL;
    if (!G || !G.Request || !G.Definitions || !G.Definitions.getAlbum) throw new Error("GraphQL: unavailable");
    const locale = (Spicetify.Locale && Spicetify.Locale.getLocale && Spicetify.Locale.getLocale()) || "en";
    const res = await G.Request(G.Definitions.getAlbum, { uri: albumUri, locale, offset: 0, limit: 500 });
    const album = res && res.data && res.data.albumUnion;
    const list = album && ((album.tracksV2 && album.tracksV2.items) || (album.tracks && album.tracks.items));
    if (!Array.isArray(list)) throw new Error("GraphQL: no tracks");
    return list.map((it) => {
      const t = (it && it.track) || it || {};
      return trackOf(t.uri, t.name, t.trackNumber);
    });
  }

  async function tracksViaMetadata(albumUri, base) {
    const data = await Spicetify.CosmosAsync.get(base + "album/" + idToGid(albumUri.split(":")[2]));
    const discs = data && data.disc;
    if (!Array.isArray(discs)) throw new Error("Metadata: no tracks");
    const out = [];
    for (const d of discs) for (const t of d.track || []) if (t && t.gid) out.push(trackOf("spotify:track:" + gidToId(t.gid), t.name, t.number));
    return out;
  }

  async function resolveAlbumTracks(albumUri) {
    const attempts = [
      () => tracksViaWebApi(albumUri),
      () => tracksViaGraphQL(albumUri),
      () => tracksViaMetadata(albumUri, "https://spclient.wg.spotify.com/metadata/4/"),
      () => tracksViaMetadata(albumUri, "sp://metadata/4/"),
    ];
    for (const attempt of attempts) {
      try {
        const seen = new Set();
        const list = (await attempt()).filter((t) => {
          if (!t.name || !RELEASE_URI_RE.test(t.uri) || !isTrackUri(t.uri) || seen.has(t.uri)) return false;
          seen.add(t.uri);
          return true;
        });
        if (list.length) return list;
      } catch (e) {
      }
    }
    return [];
  }

  async function resolveRenameTargets(uri) {
    const album = await resolveRelease(uri);
    const isTrack = isTrackUri(uri);
    let tracks = [];
    try {
      tracks = await resolveAlbumTracks(album.uri);
    } catch (e) {
      console.warn(LOG, "Couldn't load the song list", e);
    }
    if (isTrack && !tracks.some((t) => t.uri === uri)) {
      const it = playingItem();
      if (it && it.uri === uri && it.name) tracks.push(trackOf(uri, it.name, tracks.length + 1));
    }
    return { album, tracks, focus: isTrack ? uri : null };
  }

  const cleanName = (s) =>
    String(s == null ? "" : s)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MAX);

  function ensureRenameStyle() {
    if (document.getElementById("aaor-style")) return;
    const s = document.createElement("style");
    s.id = "aaor-style";
    s.textContent = `
.aaor{display:flex;flex-direction:column;gap:10px;width:100%;color:var(--spice-text,#fff);font-family:inherit}
.aaor *{box-sizing:border-box}
.aaor-sub{font-size:14px;color:var(--spice-subtext,#b3b3b3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aaor-label{margin-top:6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--spice-subtext,#b3b3b3)}
.aaor-list{max-height:min(46vh,360px);overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:6px}
.aaor-row{display:flex;align-items:center;gap:8px}
.aaor-num{flex:0 0 28px;text-align:right;font-size:13px;color:var(--spice-subtext,#b3b3b3);font-variant-numeric:tabular-nums}
.aaor-input{flex:1 1 auto;min-width:0;height:36px;padding:0 10px;border:0;border-radius:4px;background:var(--spice-card,#282828);color:var(--spice-text,#fff);font:inherit;font-size:14px;outline:none;box-shadow:inset 0 0 0 1px transparent}
.aaor-input.aaor-changed{box-shadow:inset 0 0 0 1px var(--spice-button,#1ed760)}
.aaor-input:focus{box-shadow:inset 0 0 0 2px var(--spice-text,#fff)}
.aaor-reset{flex:0 0 32px;height:32px;border:0;border-radius:50%;background:transparent;color:var(--spice-subtext,#b3b3b3);font-size:16px;line-height:32px;cursor:pointer}
.aaor-reset:hover:not(:disabled){color:var(--spice-text,#fff)}
.aaor-reset:disabled{opacity:.25;cursor:default}
.aaor-reset:focus-visible{outline:2px solid var(--spice-text,#fff)}
.aaor-note{font-size:13px;line-height:1.5;color:var(--spice-subtext,#b3b3b3)}
.aaor-status{min-height:20px;font-size:13px;color:var(--spice-subtext,#b3b3b3)}
.aaor-status.aao-error{color:var(--spice-notification-error,#f3727f)}
.aaor-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding-top:6px}
`;
    document.head.appendChild(s);
  }

  function openRenameEditor(rel) {
    ensureStyle();
    ensureRenameStyle();
    const album = rel.album;

    const items = [];
    const addItem = (uri, type, orig, albumUri, num) => {
      orig = String(orig || "").trim();
      if (!orig || orig.length > ORIG_MAX) return;
      const saved = names.get(uri);
      const shown = saved && saved.orig === orig ? saved.name : orig;
      items.push({ uri, type, orig, albumUri, num, shown, input: null, reset: null });
    };
    addItem(album.uri, "album", album.name, null, 0);
    rel.tracks.forEach((t, i) => addItem(t.uri, "track", t.name, album.uri, i + 1));
    if (!items.length || items[0].type !== "album") {
      notify("This release has no name to change.", true);
      return;
    }

    const root = h("div", "aaor");
    root.setAttribute("data-aao-skip", "");

    const sub = h("div", "aaor-sub", [typeLabel(album.type), album.artist].filter(Boolean).join(" \u2022 "));
    const status = h("div", "aaor-status");
    const setStatus = (msg, isError) => {
      status.textContent = msg || "";
      status.classList.toggle("aao-error", !!isError);
    };

    const effective = (it) => {
      const v = it.input.value;
      if (v === it.shown) return it.shown;
      return cleanName(v) || it.orig;
    };

    const save = h("button", "aao-btn aao-btn-primary", "Save");
    save.type = "button";
    save.disabled = true;
    const restore = h("button", "aao-btn aao-btn-secondary", "Restore originals");
    restore.type = "button";

    const hasSaved = () => items.some((it) => names.has(it.uri)) || Array.from(names.values()).some((r) => r.albumUri === album.uri);
    restore.hidden = !hasSaved();

    const refresh = () => {
      let dirty = false;
      for (const it of items) {
        const eff = effective(it);
        if (eff !== it.shown) dirty = true;
        it.input.classList.toggle("aaor-changed", eff !== it.orig);
        it.reset.disabled = eff === it.orig;
      }
      save.disabled = !dirty;
    };

    const makeRow = (it) => {
      const row = h("div", "aaor-row");
      if (it.type === "track") row.appendChild(h("span", "aaor-num", String(it.num)));
      const input = h("input", "aaor-input");
      input.type = "text";
      input.maxLength = NAME_MAX;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.placeholder = it.orig;
      input.value = it.shown;
      input.setAttribute("aria-label", it.type === "album" ? "Album name" : "Song " + it.num + " name");
      const reset = h("button", "aaor-reset", "\u21BA");
      reset.type = "button";
      reset.title = "Use the original name";
      reset.setAttribute("aria-label", "Use the original name");
      reset.addEventListener("click", () => {
        input.value = it.orig;
        refresh();
        input.focus();
      });
      input.addEventListener("input", refresh);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !save.disabled) {
          e.preventDefault();
          save.click();
        }
      });
      it.input = input;
      it.reset = reset;
      row.append(input, reset);
      return row;
    };

    root.append(sub, h("div", "aaor-label", "Album name"), makeRow(items[0]));
    const songs = items.slice(1);
    if (songs.length) {
      const list = h("div", "aaor-list");
      for (const it of songs) list.appendChild(makeRow(it));
      root.append(h("div", "aaor-label", "Songs (" + songs.length + ")"), list);
    } else {
      root.appendChild(h("div", "aaor-note", "Couldn\u2019t load the song list, so only the album name can be changed right now."));
    }
    root.appendChild(
      h("div", "aaor-note", "Names are changed on this device only, everywhere in the app. Leave a field empty or press \u21BA to go back to the original.")
    );
    const actions = h("div", "aaor-actions");
    actions.append(restore, save);
    root.append(status, actions);

    save.addEventListener("click", () => {
      save.disabled = true;
      restore.disabled = true;
      try {
        for (const it of items) {
          const eff = effective(it);
          if (eff === it.orig) names.delete(it.uri);
          else {
            names.set(it.uri, { uri: it.uri, type: it.type, orig: it.orig, name: eff, albumUri: it.albumUri, savedAt: Date.now() });
          }
        }
        const persisted = persistNames();
        reindexNames();
        rescanAll();
        Spicetify.PopupModal.hide();
        notify(persisted ? "Names updated" : "Names updated for this session only", !persisted);
      } catch (e) {
        console.error(LOG, e);
        setStatus("Couldn\u2019t save those names.", true);
        restore.disabled = false;
        refresh();
      }
    });

    restore.addEventListener("click", () => {
      restore.disabled = true;
      save.disabled = true;
      try {
        const uris = new Set(items.map((it) => it.uri));
        for (const rec of Array.from(names.values())) if (uris.has(rec.uri) || rec.albumUri === album.uri) names.delete(rec.uri);
        const persisted = persistNames();
        reindexNames();
        rescanAll();
        Spicetify.PopupModal.hide();
        notify(persisted ? "Original names restored" : "Original names restored for this session only", !persisted);
      } catch (e) {
        console.error(LOG, e);
        setStatus("Couldn\u2019t restore the original names.", true);
        restore.disabled = false;
        refresh();
      }
    });

    Spicetify.PopupModal.display({ title: "Rename album / songs", content: root });
    refresh();
    const focusItem = (rel.focus && items.find((it) => it.uri === rel.focus)) || items[0];
    setTimeout(() => {
      try {
        focusItem.input.focus();
        focusItem.input.select();
        if (focusItem.input.scrollIntoView) focusItem.input.scrollIntoView({ block: "nearest" });
      } catch (e) {
      }
    }, 60);
  }

  let renameLoading = false;
  async function editNames(uri) {
    if (renameLoading) return;
    renameLoading = true;
    try {
      openRenameEditor(await resolveRenameTargets(uri));
    } catch (e) {
      console.error(LOG, e);
      notify("Couldn\u2019t load that release.", true);
    } finally {
      renameLoading = false;
    }
  }

  async function initUI() {
    while (
      !(
        window.Spicetify &&
        Spicetify.CosmosAsync &&
        Spicetify.ContextMenu &&
        Spicetify.PopupModal &&
        Spicetify.Playbar &&
        Spicetify.Player &&
        Spicetify.showNotification
      )
    ) {
      await sleep(250);
    }

    const icon = Spicetify.SVGIcons && Spicetify.SVGIcons.edit ? "edit" : "album";

    new Spicetify.ContextMenu.Item(
      "Change cover art",
      (uris) => editRelease(uris[0]),
      (uris) => Array.isArray(uris) && uris.length === 1 && RELEASE_URI_RE.test(uris[0]),
      icon
    ).register();

    if (CONFIG.rename) {
      const renameIcon = Spicetify.SVGIcons && Spicetify.SVGIcons.subtitles ? "subtitles" : icon;
      new Spicetify.ContextMenu.Item(
        "Rename album / songs",
        (uris) => editNames(uris[0]),
        (uris) => Array.isArray(uris) && uris.length === 1 && RELEASE_URI_RE.test(uris[0]),
        renameIcon
      ).register();

      if (CONFIG.renamePlaybarButton) {
        new Spicetify.Playbar.Button("Rename album / songs", renameIcon, () => {
          const data = Spicetify.Player.data || {};
          const uri = (data.item && data.item.uri) || (data.track && data.track.uri) || "";
          if (RELEASE_URI_RE.test(uri)) editNames(uri);
          else notify("Play a Spotify track to rename it.", true);
        });
      }
    }

    if (CONFIG.playbarButton) {
      new Spicetify.Playbar.Button("Change cover art", icon, () => {
        const data = Spicetify.Player.data || {};
        const uri = (data.item && data.item.uri) || (data.track && data.track.uri) || "";
        if (RELEASE_URI_RE.test(uri)) editRelease(uri);
        else notify("Play a Spotify track to change its cover art.", true);
      });
    }
  }

  installHooks();
  startObserver();
  if (CONFIG.rename) startRename();
  const loaded = loadAll().catch((e) => console.error(LOG, e));
  initUI().catch((e) => console.error(LOG, e));
  Promise.all([loaded, waitForColorHooks()]).then(() =>
    setTimeout(() => refreshThemeColors(Array.from(keyIndex.keys())), 1500)
  );
})();
