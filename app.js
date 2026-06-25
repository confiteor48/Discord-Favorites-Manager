const state = {
  fileName: "",
  raw: null,
  media: [],
  failedMedia: new Set(),
  selectedMedia: new Set(),
  dragSignature: "",
  pointerDragSignature: "",
  targetFileName: "",
  targetRaw: null,
};

const els = {
  fileInput: document.querySelector("#fileInput"),
  dropzone: document.querySelector("#dropzone"),
  search: document.querySelector("#search"),
  formatFilter: document.querySelector("#formatFilter"),
  sort: document.querySelector("#sort"),
  discordToken: document.querySelector("#discordToken"),
  targetDiscordToken: document.querySelector("#targetDiscordToken"),
  targetFileInput: document.querySelector("#targetFileInput"),
  selectMenu: document.querySelector("#selectMenu"),
  patchMode: document.querySelector("#patchMode"),
  mergePlacement: document.querySelector("#mergePlacement"),
  fetchSettings: document.querySelector("#fetchSettings"),
  refreshUrls: document.querySelector("#refreshUrls"),
  removeFailed: document.querySelector("#removeFailed"),
  removeSelected: document.querySelector("#removeSelected"),
  patchSelected: document.querySelector("#patchSelected"),
  patchDiscord: document.querySelector("#patchDiscord"),
  downloadJson: document.querySelector("#downloadJson"),
  status: document.querySelector("#status"),
  stats: document.querySelector("#stats"),
  mediaCount: document.querySelector("#mediaCount"),
  mediaGrid: document.querySelector("#mediaGrid"),
};

const urlPattern = /^https?:\/\//i;
const imagePattern = /\.(gif|png|jpe?g|webp|avif|bmp|svg)(\?|#|$)/i;
const videoPattern = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const refreshEndpoint = "https://discord.com/api/v9/attachments/refresh-urls";
const settingsProtoEndpoint = "https://discord.com/api/v9/users/@me/settings-proto/2";
const refreshBatchSize = 50;
const gifTypeNames = ["NONE", "IMAGE", "VIDEO"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getUrl(value) {
  if (typeof value !== "string") return "";
  return urlPattern.test(value) ? value : "";
}

function inferFormat(entry, source) {
  const explicit = String(entry.format || entry.type || "").toUpperCase();
  if (explicit.includes("VIDEO")) return "VIDEO";
  if (explicit.includes("IMAGE") || explicit.includes("GIF") || explicit.includes("STICKER") || explicit.includes("EMOJI")) return "IMAGE";
  if (videoPattern.test(source)) return "VIDEO";
  if (imagePattern.test(source)) return "IMAGE";
  return "OTHER";
}

function looksLikeMedia(value, key) {
  if (!isObject(value)) return false;
  const source = getUrl(value.src) || getUrl(value.url) || getUrl(value.source) || getUrl(value.media);
  const keyUrl = getUrl(key);
  return Boolean(source || keyUrl) && (
    "format" in value ||
    "width" in value ||
    "height" in value ||
    source && (imagePattern.test(source) || videoPattern.test(source)) ||
    keyUrl && (imagePattern.test(keyUrl) || videoPattern.test(keyUrl))
  );
}

function walk(value, path, parentKey, output) {
  if (looksLikeMedia(value, parentKey)) {
    const src = getUrl(value.src) || getUrl(value.url) || getUrl(value.source) || getUrl(value.media) || getUrl(parentKey);
    const href = getUrl(parentKey) || src;
    const format = inferFormat(value, src);
    output.media.push({
      path,
      key: parentKey,
      href,
      src,
      format,
      width: Number(value.width) || 0,
      height: Number(value.height) || 0,
      slot: Number.isFinite(Number(value.slot)) ? Number(value.slot) : null,
      raw: value,
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, String(index), output));
    return;
  }

  if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      const nextPath = path ? `${path}.${key}` : key;
      walk(item, nextPath, key, output);
    });
  }
}

function extract(json) {
  const output = { media: [] };
  walk(json, "", "root", output);
  output.media = dedupeMedia(output.media);
  return output;
}

function dedupeMedia(media) {
  const seen = new Set();
  return media.filter((item) => {
    const id = `${item.src}|${item.href}|${item.path}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseJson(text, fileName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    els.status.textContent = `Could not parse ${fileName}: ${error.message}`;
    return;
  }

  applyParsedJson(parsed, fileName, `${fileName} loaded.`);
}

function applyParsedJson(parsed, fileName, message) {
  const extracted = extract(parsed);
  state.fileName = fileName;
  state.raw = parsed;
  state.media = extracted.media;
  state.failedMedia = new Set();
  state.selectedMedia = new Set([...state.selectedMedia].filter((signature) => {
    return state.media.some((item) => mediaSignature(item) === signature);
  }));
  els.status.textContent = message;
  render();
}

async function remountParsedJson(parsed, fileName, message) {
  els.mediaGrid.replaceChildren();
  els.mediaCount.textContent = "Reloading preview...";
  await nextFrame();
  applyParsedJson(JSON.parse(JSON.stringify(parsed)), fileName, message);
}

async function loadFile(file) {
  if (!file) return;
  parseJson(await file.text(), file.name);
}

async function loadTargetFile(file) {
  if (!file) return;
  try {
    state.targetRaw = JSON.parse(await file.text());
    state.targetFileName = file.name;
    els.status.textContent = `${file.name} loaded as target base.`;
  } catch (error) {
    state.targetRaw = null;
    state.targetFileName = "";
    els.status.textContent = `Could not parse target JSON: ${error.message}`;
  }
}

async function tryAutoload() {
  try {
    const response = await fetch("gifs.json", { cache: "no-store" });
    if (!response.ok) return;
    parseJson(await response.text(), "gifs.json");
  } catch {
    // Browsers usually block local file:// fetches. The file input remains the fallback.
  }
}

function requireDiscordToken() {
  const token = normalizeAuthToken(els.discordToken.value);
  if (!token) {
    els.status.textContent = "Paste a Discord token first. It is used for this request only and is not stored.";
    els.discordToken.focus();
    return "";
  }
  return token;
}

async function fetchSettingsProto() {
  const token = requireDiscordToken();
  if (!token) return;

  const originalText = els.fetchSettings.textContent;
  els.fetchSettings.disabled = true;
  els.fetchSettings.textContent = "Fetching...";
  els.status.textContent = "Fetching Discord GIF settings...";

  try {
    const decoded = await fetchSettingsJson(token);
    applyParsedJson(decoded, "discord-settings-proto-2.json", "Fetched and decoded Discord GIF settings.");
  } catch (error) {
    els.status.textContent = `Could not fetch GIF settings: ${error.message}`;
  } finally {
    els.fetchSettings.textContent = originalText;
    updateTokenButtons();
  }
}

async function fetchSettingsJson(token) {
  const response = await fetch(settingsProtoEndpoint, {
    headers: {
      "Authorization": token,
      "Accept": "application/json",
    },
    cache: "no-store",
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(describeDiscordError(payload) || payload.message || `HTTP ${response.status}`);
  }

  const base64 = extractSettingsBase64(payload);
  if (!base64) throw new Error("response did not include a settings protobuf value");
  return decodeSettingsProto(base64ToBytes(base64));
}

function extractSettingsBase64(payload) {
  if (typeof payload === "string") return payload;
  if (!isObject(payload)) return "";
  return payload.settings || payload.value || payload.data || payload.proto || payload.serialized || "";
}

function base64ToBytes(base64) {
  const normalized = String(base64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const clean = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

class ProtoReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.bytes.length;
  }

  readTag() {
    const tag = this.readVarintNumber();
    return { field: tag >> 3, wire: tag & 7 };
  }

  readVarintBigInt() {
    let shift = 0n;
    let result = 0n;
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos];
      this.pos += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
    throw new Error("truncated varint");
  }

  readVarintNumber() {
    return Number(this.readVarintBigInt());
  }

  readFixed64String() {
    this.ensure(8);
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(this.bytes[this.pos + index]) << BigInt(index * 8);
    }
    this.pos += 8;
    return value.toString();
  }

  readBytes() {
    const length = this.readVarintNumber();
    this.ensure(length);
    const start = this.pos;
    this.pos += length;
    return this.bytes.slice(start, this.pos);
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  readMessage(decoder) {
    return decoder(new ProtoReader(this.readBytes()));
  }

  skip(wire) {
    if (wire === 0) {
      this.readVarintBigInt();
      return;
    }
    if (wire === 1) {
      this.ensure(8);
      this.pos += 8;
      return;
    }
    if (wire === 2) {
      this.readBytes();
      return;
    }
    if (wire === 5) {
      this.ensure(4);
      this.pos += 4;
      return;
    }
    throw new Error(`unsupported protobuf wire type ${wire}`);
  }

  ensure(length) {
    if (this.pos + length > this.bytes.length) throw new Error("truncated protobuf");
  }
}

function decodeSettingsProto(bytes) {
  const reader = new ProtoReader(bytes);
  const settings = {};
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) settings.metadata = reader.readMessage(decodeMetadata);
    else if (field === 2 && wire === 2) settings.favorite_gifs = reader.readMessage(decodeFavoriteGifs);
    else if (field === 3 && wire === 2) settings.favorite_stickers = reader.readMessage((item) => decodeFixed64List(item, 1, "sticker_ids"));
    else if (field === 4 && wire === 2) settings.sticker_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "stickers", "fixed64"));
    else if (field === 5 && wire === 2) settings.favorite_emoji = reader.readMessage((item) => decodeStringList(item, 1, "emojis"));
    else if (field === 6 && wire === 2) settings.emoji_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "emojis", "string"));
    else if (field === 7 && wire === 2) settings.application_command_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "application_commands", "string"));
    else if (field === 8 && wire === 2) settings.favorite_soundboard_sounds = reader.readMessage((item) => decodeFixed64List(item, 1, "sound_ids"));
    else if (field === 9 && wire === 2) settings.application_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "applications", "string"));
    else if (field === 10 && wire === 2) settings.heard_sound_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "heard_sounds", "string"));
    else if (field === 11 && wire === 2) settings.played_sound_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "played_sounds", "string"));
    else if (field === 12 && wire === 2) settings.guild_and_channel_frequency = reader.readMessage((item) => decodeFrequencyMap(item, 1, "guild_and_channels", "fixed64"));
    else reader.skip(wire);
  }
  return settings;
}

function decodeMetadata(reader) {
  const metadata = {};
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (wire === 0 && field === 1) metadata.client_version = reader.readVarintNumber();
    else if (wire === 0 && field === 2) metadata.server_version = reader.readVarintNumber();
    else if (wire === 0 && field === 3) metadata.times_changed = reader.readVarintNumber();
    else reader.skip(wire);
  }
  return metadata;
}

function decodeFavoriteGifs(reader) {
  const result = { gifs: {} };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      const entry = reader.readMessage(decodeFavoriteGifMapEntry);
      if (entry.key) result.gifs[entry.key] = entry.value || {};
    } else if (field === 2 && wire === 0) {
      result.hide_tooltip = Boolean(reader.readVarintNumber());
    } else {
      reader.skip(wire);
    }
  }
  return result;
}

function decodeFavoriteGifMapEntry(reader) {
  const entry = { key: "", value: {} };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) entry.key = reader.readString();
    else if (field === 2 && wire === 2) entry.value = reader.readMessage(decodeFavoriteGif);
    else reader.skip(wire);
  }
  return entry;
}

function decodeFavoriteGif(reader) {
  const gif = {};
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (wire === 0 && field === 1) {
      const value = reader.readVarintNumber();
      gif.format = gifTypeNames[value] || String(value);
    } else if (wire === 2 && field === 2) {
      gif.src = reader.readString();
    } else if (wire === 0 && field === 3) {
      gif.width = reader.readVarintNumber();
    } else if (wire === 0 && field === 4) {
      gif.height = reader.readVarintNumber();
    } else if (wire === 0 && field === 5) {
      gif.slot = reader.readVarintNumber();
    } else {
      reader.skip(wire);
    }
  }
  return gif;
}

function decodeFrequencyItem(reader) {
  const item = {};
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 0) item.total_uses = reader.readVarintNumber();
    else if (field === 2 && wire === 0) {
      item.recent_uses ||= [];
      item.recent_uses.push(reader.readVarintBigInt().toString());
    } else if (field === 2 && wire === 2) {
      item.recent_uses ||= [];
      const packed = new ProtoReader(reader.readBytes());
      while (!packed.done) item.recent_uses.push(packed.readVarintBigInt().toString());
    } else if (field === 3 && wire === 0) item.frequency = reader.readVarintNumber();
    else if (field === 4 && wire === 0) item.score = reader.readVarintNumber();
    else reader.skip(wire);
  }
  return item;
}

function decodeFixed64List(reader, fieldNumber, key) {
  const result = { [key]: [] };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === fieldNumber && wire === 1) result[key].push(reader.readFixed64String());
    else if (field === fieldNumber && wire === 2) {
      const packed = new ProtoReader(reader.readBytes());
      while (!packed.done) result[key].push(packed.readFixed64String());
    } else {
      reader.skip(wire);
    }
  }
  return result;
}

function decodeStringList(reader, fieldNumber, key) {
  const result = { [key]: [] };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === fieldNumber && wire === 2) result[key].push(reader.readString());
    else reader.skip(wire);
  }
  return result;
}

function decodeFrequencyMap(reader, fieldNumber, key, keyType) {
  const result = { [key]: {} };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === fieldNumber && wire === 2) {
      const entry = reader.readMessage((item) => decodeFrequencyMapEntry(item, keyType));
      if (entry.key !== "") result[key][entry.key] = entry.value || {};
    } else {
      reader.skip(wire);
    }
  }
  return result;
}

function decodeFrequencyMapEntry(reader, keyType) {
  const entry = { key: "", value: {} };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && keyType === "string" && wire === 2) entry.key = reader.readString();
    else if (field === 1 && keyType === "fixed64" && wire === 1) entry.key = reader.readFixed64String();
    else if (field === 2 && wire === 2) entry.value = reader.readMessage(decodeFrequencyItem);
    else reader.skip(wire);
  }
  return entry;
}

class ProtoWriter {
  constructor() {
    this.bytes = [];
  }

  writeTag(field, wire) {
    this.writeVarint((field << 3) | wire);
  }

  writeVarint(value) {
    let next = BigInt(value);
    if (next < 0) next = BigInt.asUintN(64, next);
    do {
      let byte = Number(next & 0x7fn);
      next >>= 7n;
      if (next) byte |= 0x80;
      this.bytes.push(byte);
    } while (next);
  }

  writeUint32(field, value) {
    if (value === undefined || value === null) return;
    this.writeTag(field, 0);
    this.writeVarint(Number(value) >>> 0);
  }

  writeInt32(field, value) {
    if (value === undefined || value === null) return;
    this.writeTag(field, 0);
    this.writeVarint(BigInt(Number(value)));
  }

  writeBool(field, value) {
    if (value === undefined || value === null) return;
    this.writeTag(field, 0);
    this.writeVarint(value ? 1 : 0);
  }

  writeUint64(field, value) {
    if (value === undefined || value === null) return;
    this.writeTag(field, 0);
    this.writeVarint(BigInt(value));
  }

  writeFixed64(field, value) {
    if (value === undefined || value === null || value === "") return;
    this.writeTag(field, 1);
    let next = BigInt(value);
    for (let index = 0; index < 8; index += 1) {
      this.bytes.push(Number(next & 0xffn));
      next >>= 8n;
    }
  }

  writeString(field, value) {
    if (value === undefined || value === null || value === "") return;
    this.writeBytes(field, new TextEncoder().encode(String(value)));
  }

  writeMessage(field, writer) {
    if (!writer || !writer.bytes.length) return;
    this.writeBytes(field, new Uint8Array(writer.bytes));
  }

  writeBytes(field, bytes) {
    this.writeTag(field, 2);
    this.writeVarint(bytes.length);
    this.bytes.push(...bytes);
  }

  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
}

function encodeSettingsProto(settings) {
  const writer = new ProtoWriter();
  writer.writeMessage(1, encodeMetadata(settings.metadata));
  writer.writeMessage(2, encodeFavoriteGifs(settings.favorite_gifs));
  writer.writeMessage(3, encodeFixed64List(settings.favorite_stickers?.sticker_ids, 1));
  writer.writeMessage(4, encodeFrequencyMap(settings.sticker_frequency?.stickers, 1, "fixed64"));
  writer.writeMessage(5, encodeStringList(settings.favorite_emoji?.emojis, 1));
  writer.writeMessage(6, encodeFrequencyMap(settings.emoji_frequency?.emojis, 1, "string"));
  writer.writeMessage(7, encodeFrequencyMap(settings.application_command_frequency?.application_commands, 1, "string"));
  writer.writeMessage(8, encodeFixed64List(settings.favorite_soundboard_sounds?.sound_ids, 1));
  writer.writeMessage(9, encodeFrequencyMap(settings.application_frequency?.applications, 1, "string"));
  writer.writeMessage(10, encodeFrequencyMap(settings.heard_sound_frequency?.heard_sounds, 1, "string"));
  writer.writeMessage(11, encodeFrequencyMap(settings.played_sound_frequency?.played_sounds, 1, "string"));
  writer.writeMessage(12, encodeFrequencyMap(settings.guild_and_channel_frequency?.guild_and_channels, 1, "fixed64"));
  return writer.toUint8Array();
}

function encodeMetadata(metadata = {}) {
  const writer = new ProtoWriter();
  writer.writeUint32(1, metadata.client_version);
  writer.writeUint32(2, metadata.server_version);
  writer.writeUint32(3, metadata.times_changed);
  return writer;
}

function encodeFavoriteGifs(favoriteGifs = {}) {
  const writer = new ProtoWriter();
  for (const [key, value] of Object.entries(favoriteGifs.gifs || {})) {
    const entry = new ProtoWriter();
    entry.writeString(1, key);
    entry.writeMessage(2, encodeFavoriteGif(value));
    writer.writeMessage(1, entry);
  }
  writer.writeBool(2, favoriteGifs.hide_tooltip);
  return writer;
}

function encodeFavoriteGif(gif = {}) {
  const writer = new ProtoWriter();
  writer.writeUint32(1, gifFormatNumber(gif.format));
  writer.writeString(2, gif.src);
  writer.writeUint32(3, gif.width);
  writer.writeUint32(4, gif.height);
  writer.writeUint32(5, gif.slot);
  return writer;
}

function gifFormatNumber(format) {
  if (typeof format === "number") return format;
  const index = gifTypeNames.indexOf(String(format || "").toUpperCase());
  return index >= 0 ? index : 0;
}

function encodeFrequencyItem(item = {}) {
  const writer = new ProtoWriter();
  writer.writeUint32(1, item.total_uses);
  (item.recent_uses || []).forEach((value) => writer.writeUint64(2, value));
  writer.writeInt32(3, item.frequency);
  writer.writeInt32(4, item.score);
  return writer;
}

function encodeFixed64List(values, fieldNumber) {
  const writer = new ProtoWriter();
  (values || []).forEach((value) => writer.writeFixed64(fieldNumber, value));
  return writer;
}

function encodeStringList(values, fieldNumber) {
  const writer = new ProtoWriter();
  (values || []).forEach((value) => writer.writeString(fieldNumber, value));
  return writer;
}

function encodeFrequencyMap(map, fieldNumber, keyType) {
  const writer = new ProtoWriter();
  for (const [key, value] of Object.entries(map || {})) {
    const entry = new ProtoWriter();
    if (keyType === "fixed64") entry.writeFixed64(1, key);
    else entry.writeString(1, key);
    entry.writeMessage(2, encodeFrequencyItem(value));
    writer.writeMessage(fieldNumber, entry);
  }
  return writer;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function activeMedia() {
  const query = els.search.value.trim().toLowerCase();
  const format = els.formatFilter.value;
  const sorted = state.media.filter((item) => {
    const haystack = `${item.src} ${item.href} ${item.path} ${item.key}`.toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesFormat = format === "all" || item.format === format || format === "OTHER" && item.format !== "IMAGE" && item.format !== "VIDEO";
    return matchesQuery && matchesFormat;
  });

  sorted.sort((a, b) => {
    if (els.sort.value === "source") return a.href.localeCompare(b.href);
    if (els.sort.value === "size") return b.width * b.height - a.width * a.height;
    if (els.sort.value === "format") return a.format.localeCompare(b.format) || compareSlot(a, b);
    return compareSlot(a, b);
  });
  return sorted;
}

function compareSlot(a, b) {
  if (a.slot !== null && b.slot !== null) return b.slot - a.slot;
  if (a.slot !== null) return -1;
  if (b.slot !== null) return 1;
  return a.path.localeCompare(b.path);
}

function render() {
  renderStats();
  renderMedia();
  updateFailedButton();
  updateSelectedButtons();
  updateTokenButtons();
}

function renderStats() {
  const imageCount = state.media.filter((item) => item.format === "IMAGE").length;
  const videoCount = state.media.filter((item) => item.format === "VIDEO").length;
  const refreshableCount = collectDiscordAttachmentUrls().length;
  els.stats.innerHTML = [
    stat("Media", state.media.length),
    stat("Images", imageCount),
    stat("Videos", videoCount),
    stat("Discord URLs", refreshableCount),
  ].join("");
}

function stat(label, value) {
  return `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderMedia() {
  const items = activeMedia();
  els.mediaCount.textContent = `${items.length} shown`;
  if (!items.length) {
    els.mediaGrid.innerHTML = `<div class="empty">No media entries match the current filters.</div>`;
    return;
  }

  els.mediaGrid.innerHTML = items.map((item) => {
    const index = state.media.indexOf(item);
    const size = item.width && item.height ? `${item.width} x ${item.height}` : "unknown size";
    const fileName = displayFileName(item);
    const metadata = renderMetadata(item);
    const failed = state.failedMedia.has(mediaKey(item));
    const selected = state.selectedMedia.has(mediaSignature(item));
    const media = item.format === "VIDEO"
      ? failed
        ? `<div class="failed">Preview failed. Open source link.</div>`
        : `<video src="${escapeAttr(item.src)}" data-index="${index}" autoplay muted loop playsinline preload="metadata"></video>`
      : item.format === "IMAGE"
        ? failed
          ? `<div class="failed">Preview failed. Open source link.</div>`
          : `<img src="${escapeAttr(item.src)}" data-index="${index}" loading="lazy" alt="">`
        : `<div class="failed">No renderer for this media type</div>`;
    return `
      <article class="card" draggable="true" data-index="${index}">
        <div class="thumb">
          <input class="select-media" type="checkbox" data-index="${index}" ${selected ? "checked" : ""} aria-label="Select ${escapeAttr(fileName)}">
          ${media}
        </div>
        <div class="meta">
          <a class="source-link" href="${escapeAttr(item.href)}" target="_blank" rel="noreferrer" title="${escapeAttr(item.href)}">${escapeHtml(fileName)}</a>
          <div class="details">
            <div class="detail"><span>Size</span><strong title="${escapeAttr(size)}">${escapeHtml(size)}</strong></div>
            <div class="detail"><span>Slot</span><strong>${item.slot === null ? "-" : escapeHtml(item.slot)}</strong></div>
          </div>
          <div class="actions">
            <button type="button" data-action="copy-url" data-index="${index}" title="Copy URL for Discord">URL</button>
            <button type="button" data-action="save-gif" data-index="${index}" title="Save this media as a .gif file">Save</button>
          </div>
          <div class="meta-list">${metadata}</div>
        </div>
      </article>
    `;
  }).join("");

  document.querySelectorAll(".thumb img, .thumb video").forEach((node) => {
    node.addEventListener("error", () => {
      markMediaFailed(Number(node.dataset.index), node);
    }, { once: true });
  });
}

function markMediaFailed(index, node) {
  const item = state.media[index];
  if (!item) return;
  state.failedMedia.add(mediaKey(item));
  updateFailedButton();
  node.replaceWith(Object.assign(document.createElement("div"), {
    className: "failed",
    textContent: "Preview failed. Open source link.",
  }));
}

function updateFailedButton() {
  const count = state.failedMedia.size;
  els.removeFailed.disabled = count === 0;
  els.removeFailed.textContent = count ? `Remove failed (${count})` : "Remove failed";
}

function mediaKey(item) {
  return `${item.src}|${item.href}|${item.path}`;
}

function mediaSignatureFromParts(src, href) {
  return `${src}|${href}`;
}

function mediaSignature(item) {
  return mediaSignatureFromParts(item.src, item.href);
}

function updateSelectedButtons() {
  const count = state.selectedMedia.size;
  els.removeSelected.disabled = count === 0;
  els.patchSelected.disabled = count === 0 || !hasPatchToken();
  els.removeSelected.textContent = count ? `Remove selected (${count})` : "Remove selected";
  els.patchSelected.textContent = count ? `Patch selected (${count})` : "Patch selected";
  els.patchSelected.title = hasPatchToken() ? "" : "Paste a source or target Discord token to patch.";
}

function hasSourceToken() {
  return Boolean(normalizeAuthToken(els.discordToken.value));
}

function hasPatchToken() {
  return Boolean(normalizeAuthToken(els.discordToken.value) || normalizeAuthToken(els.targetDiscordToken.value));
}

function updateTokenButtons() {
  const sourceToken = hasSourceToken();
  const patchToken = hasPatchToken();
  els.fetchSettings.disabled = !sourceToken;
  els.refreshUrls.disabled = !sourceToken;
  els.patchDiscord.disabled = !patchToken;
  els.fetchSettings.title = sourceToken ? "" : "Paste a source Discord token to fetch GIF settings.";
  els.refreshUrls.title = sourceToken ? "" : "Paste a source Discord token to refresh Discord attachment URLs.";
  els.patchDiscord.title = patchToken ? "" : "Paste a source or target Discord token to patch Discord.";
  if (!patchToken) els.patchSelected.disabled = true;
}

function handleSelectionChange(event) {
  const checkbox = event.target.closest(".select-media");
  if (!checkbox) return;
  const item = state.media[Number(checkbox.dataset.index)];
  if (!item) return;
  const signature = mediaSignature(item);
  if (checkbox.checked) state.selectedMedia.add(signature);
  else state.selectedMedia.delete(signature);
  updateSelectedButtons();
}

function applySelectionMenu() {
  const action = els.selectMenu.value;
  els.selectMenu.value = "";
  if (!action) return;

  if (action === "clear") {
    state.selectedMedia.clear();
  } else if (action === "shown") {
    activeMedia().forEach((item) => state.selectedMedia.add(mediaSignature(item)));
  } else if (action === "failed") {
    state.media.forEach((item) => {
      if (state.failedMedia.has(mediaKey(item))) state.selectedMedia.add(mediaSignature(item));
    });
  }

  renderMedia();
  updateSelectedButtons();
}

function handleDragStart(event) {
  const card = event.target.closest(".card[draggable='true']");
  if (!card || event.target.closest("input, button, a, select")) {
    event.preventDefault();
    return;
  }
  const item = state.media[Number(card.dataset.index)];
  if (!item) return;
  state.dragSignature = mediaSignature(item);
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.dragSignature);
}

function handleDragOver(event) {
  const card = event.target.closest(".card[draggable='true']");
  if (!card || !state.dragSignature) return;
  event.preventDefault();
  card.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
}

function handleDragLeave(event) {
  const card = event.target.closest(".card.drag-over");
  if (card && !card.contains(event.relatedTarget)) card.classList.remove("drag-over");
}

async function handleDrop(event) {
  const card = event.target.closest(".card[draggable='true']");
  if (!card || !state.dragSignature) return;
  event.preventDefault();
  const target = state.media[Number(card.dataset.index)];
  if (!target) return;
  const dragged = state.dragSignature;
  state.dragSignature = "";
  document.querySelectorAll(".card.dragging, .card.drag-over").forEach((node) => {
    node.classList.remove("dragging", "drag-over");
  });
  await reorderBySignatures(dragged, mediaSignature(target));
}

function handleDragEnd() {
  state.dragSignature = "";
  document.querySelectorAll(".card.dragging, .card.drag-over").forEach((node) => {
    node.classList.remove("dragging", "drag-over");
  });
}

function handlePointerDown(event) {
  const card = event.target.closest(".card[draggable='true']");
  if (!card || event.target.closest("input, button, a, select")) return;
  const item = state.media[Number(card.dataset.index)];
  if (!item) return;
  state.pointerDragSignature = mediaSignature(item);
  card.classList.add("dragging");
}

function handlePointerMove(event) {
  if (!state.pointerDragSignature) return;
  const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".card[draggable='true']");
  document.querySelectorAll(".card.drag-over").forEach((node) => {
    if (node !== card) node.classList.remove("drag-over");
  });
  if (card) card.classList.add("drag-over");
}

async function handlePointerUp(event) {
  if (!state.pointerDragSignature) return;
  const dragged = state.pointerDragSignature;
  state.pointerDragSignature = "";
  const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".card[draggable='true']");
  document.querySelectorAll(".card.dragging, .card.drag-over").forEach((node) => {
    node.classList.remove("dragging", "drag-over");
  });
  if (!card) return;
  const target = state.media[Number(card.dataset.index)];
  if (!target) return;
  await reorderBySignatures(dragged, mediaSignature(target));
}

async function reorderBySignatures(draggedSignature, targetSignature) {
  if (!draggedSignature || draggedSignature === targetSignature) return;
  const shown = activeMedia();
  const from = shown.findIndex((item) => mediaSignature(item) === draggedSignature);
  const to = shown.findIndex((item) => mediaSignature(item) === targetSignature);
  if (from < 0 || to < 0) return;
  const [moved] = shown.splice(from, 1);
  shown.splice(to, 0, moved);
  applyVisualSlotOrder(shown);
  els.sort.value = "slot";
  await remountParsedJson(state.raw, state.fileName || "gifs.json", "Reordered GIFs. Use Download JSON or Patch Discord to keep the new order.");
}

function applyVisualSlotOrder(orderedItems) {
  const visibleSignatures = new Set(orderedItems.map(mediaSignature));
  const hiddenItems = state.media.filter((item) => !visibleSignatures.has(mediaSignature(item)));
  assignSlotsForItems([...orderedItems, ...hiddenItems]);
}

function assignSlotsForItems(items) {
  const total = items.length;
  items.forEach((item, index) => {
    const slot = total - index;
    item.slot = slot;
    if (item.raw && isObject(item.raw)) item.raw.slot = slot;
  });
}

async function handleMediaAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const item = state.media[Number(button.dataset.index)];
  if (!item) return;

  if (button.dataset.action === "copy-url") {
    await copyText(item.href || item.src, "Discord URL copied.");
    return;
  }

  if (button.dataset.action === "save-gif") {
    await saveGif(item, button);
  }
}

async function removeFailedMedia() {
  if (!state.raw || !state.failedMedia.size) {
    els.status.textContent = "No failed previews to remove.";
    return;
  }

  const failedItems = state.media.filter((item) => state.failedMedia.has(mediaKey(item)));
  const removed = await removeMediaBySignatures(new Set(failedItems.map(mediaSignature)), "failed preview");
  state.failedMedia.clear();
  if (!removed) els.status.textContent = "No matching failed previews were found in the JSON.";
}

async function removeSelectedMedia() {
  if (!state.raw || !state.selectedMedia.size) {
    els.status.textContent = "No selected GIFs to remove.";
    return;
  }

  const removed = await removeMediaBySignatures(new Set(state.selectedMedia), "selected GIF");
  state.selectedMedia.clear();
  if (!removed) els.status.textContent = "No matching selected GIFs were found in the JSON.";
}

async function removeMediaBySignatures(targetSignatures, label) {
  const removed = removeMediaEntries(state.raw, targetSignatures);
  for (const signature of targetSignatures) state.selectedMedia.delete(signature);

  await remountParsedJson(
    state.raw,
    state.fileName || "gifs.json",
    removed
      ? `Removed ${removed} ${label}${removed === 1 ? "" : "s"}. Use Download JSON to save the cleaned file.`
      : `No matching ${label}s were found in the JSON.`
  );
  return removed;
}

function removeMediaEntries(value, targetSignatures, parentKey = "") {
  let removed = 0;

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (looksLikeMedia(item, String(index)) && targetSignatures.has(rawMediaSignature(item, String(index)))) {
        value.splice(index, 1);
        removed += 1;
      } else {
        removed += removeMediaEntries(item, targetSignatures, String(index));
      }
    }
    return removed;
  }

  if (!isObject(value)) return 0;

  for (const [key, item] of Object.entries(value)) {
    if (looksLikeMedia(item, key) && targetSignatures.has(rawMediaSignature(item, key))) {
      delete value[key];
      removed += 1;
    } else {
      removed += removeMediaEntries(item, targetSignatures, key);
    }
  }

  return removed;
}

function rawMediaSignature(value, key) {
  const src = getUrl(value.src) || getUrl(value.url) || getUrl(value.source) || getUrl(value.media) || getUrl(key);
  const href = getUrl(key) || src;
  return mediaSignatureFromParts(src, href);
}

async function patchDiscordSettings(selectedOnly = false) {
  if (!state.raw) {
    els.status.textContent = "Load or fetch source GIF settings before patching.";
    return;
  }

  const token = normalizeAuthToken(els.targetDiscordToken.value) || requireDiscordToken();
  if (!token) return;
  if (selectedOnly && !state.selectedMedia.size) {
    els.status.textContent = "Select at least one GIF before patching selected.";
    return;
  }

  const button = selectedOnly ? els.patchSelected : els.patchDiscord;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Patching...";

  try {
    const { settings, gifCount } = await buildPatchSettings(token, selectedOnly);
    if (!gifCount) throw new Error("no favorite GIFs matched the patch scope");
    const encoded = bytesToBase64(encodeSettingsProto(settings));
    const response = await fetch(settingsProtoEndpoint, {
      method: "PATCH",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ settings: encoded }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(describeDiscordError(payload) || payload.message || `HTTP ${response.status}`);
    }

    applyParsedJson(settings, "patched-settings-proto-2.json", `Patched ${gifCount} favorite GIF${gifCount === 1 ? "" : "s"} to Discord.`);
  } catch (error) {
    els.status.textContent = `Could not patch Discord: ${error.message}`;
  } finally {
    button.textContent = originalText;
    updateTokenButtons();
    updateSelectedButtons();
  }
}

async function buildPatchSettings(token, selectedOnly) {
  const sourceSignatures = selectedOnly ? new Set(state.selectedMedia) : null;
  const sourceGifs = favoriteGifMapFromSettings(state.raw, sourceSignatures);
  const mode = els.patchMode.value;
  let base = await resolvePatchBase(token, mode);
  base = cloneJson(base || {});
  base.favorite_gifs ||= {};

  if (mode === "merge") {
    base.favorite_gifs.gifs = mergeFavoriteGifMaps(base.favorite_gifs.gifs || {}, sourceGifs, els.mergePlacement.value);
  } else {
    base.favorite_gifs.gifs = assignSlotsForGifMap(dedupeFavoriteGifMap(sourceGifs));
  }

  if (base.favorite_gifs.hide_tooltip === undefined && state.raw.favorite_gifs?.hide_tooltip !== undefined) {
    base.favorite_gifs.hide_tooltip = state.raw.favorite_gifs.hide_tooltip;
  }

  return {
    settings: base,
    gifCount: Object.keys(base.favorite_gifs.gifs || {}).length,
  };
}

async function resolvePatchBase(token, mode) {
  if (state.targetRaw) return state.targetRaw;
  if (normalizeAuthToken(els.targetDiscordToken.value)) {
    els.status.textContent = `Fetching target settings for ${mode}...`;
    return fetchSettingsJson(token);
  }
  return state.raw;
}

function favoriteGifMapFromSettings(settings, signatures = null) {
  const gifs = {};
  for (const [key, value] of Object.entries(settings.favorite_gifs?.gifs || {})) {
    if (signatures && !signatures.has(rawMediaSignature(value, key))) continue;
    gifs[key] = cloneJson(value);
  }
  return dedupeFavoriteGifMap(gifs);
}

function mergeFavoriteGifMaps(targetGifs, sourceGifs, placement) {
  const targetEntries = orderedGifEntries(targetGifs || {});
  const sourceEntries = orderedGifEntries(sourceGifs || {});
  const entries = placement === "below"
    ? [...targetEntries, ...sourceEntries]
    : [...sourceEntries, ...targetEntries];
  return assignSlotsForGifMap(dedupeFavoriteGifEntries(entries), true);
}

function dedupeFavoriteGifMap(gifs) {
  return dedupeFavoriteGifEntries(Object.entries(gifs || {}));
}

function dedupeFavoriteGifEntries(entries) {
  const byIdentity = new Map();
  for (const [key, value] of entries) {
    const identity = favoriteGifIdentity(key, value);
    if (!byIdentity.has(identity)) byIdentity.set(identity, [key, cloneJson(value)]);
  }
  return Object.fromEntries([...byIdentity.values()]);
}

function orderedGifEntries(gifs) {
  return Object.entries(gifs || {}).sort((a, b) => {
    const aSlot = Number(a[1]?.slot) || 0;
    const bSlot = Number(b[1]?.slot) || 0;
    return bSlot - aSlot;
  });
}

function assignSlotsForGifMap(gifs, preserveOrder = false) {
  const entries = preserveOrder ? Object.entries(gifs || {}) : orderedGifEntries(gifs);
  const total = entries.length;
  return Object.fromEntries(entries.map(([key, value], index) => {
    const next = cloneJson(value);
    next.slot = total - index;
    return [key, next];
  }));
}

function favoriteGifIdentity(key, value) {
  const url = getUrl(key) || getUrl(value?.src);
  if (!url) return String(key);
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/attachments/") && /(^|\.)discordapp\.(com|net)$/i.test(parsed.hostname)) {
      return `https://cdn.discordapp.com${parsed.pathname}`;
    }
    ["ex", "is", "hm", "hs"].forEach((param) => parsed.searchParams.delete(param));
    parsed.hash = "";
    const query = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return String(key).replace(/[?&](ex|is|hm|hs)=[^&]*/gi, "");
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function copyText(text, message) {
  if (!navigator.clipboard?.writeText) {
    els.status.textContent = text;
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    els.status.textContent = message;
  } catch (error) {
    els.status.textContent = `Could not copy URL: ${error.message}`;
  }
}

function getGifCandidates(item) {
  const urls = [item.href, item.src, stripDiscordImageFormat(item.href), stripDiscordImageFormat(item.src)];
  return [...new Set(urls.filter((url) => url && /\.gif(\?|#|$)/i.test(url)))];
}

function collectDiscordAttachmentUrls() {
  const urls = state.media
    .flatMap((item) => [item.src, item.href])
    .map(canonicalAttachmentRefreshUrl)
    .filter(Boolean);
  return [...new Set(urls)];
}

function isRefreshableDiscordAttachmentUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /(^|\.)discordapp\.(com|net)$/i.test(parsed.hostname) && parsed.pathname.includes("/attachments/");
  } catch {
    return false;
  }
}

function canonicalAttachmentRefreshUrl(url) {
  if (!isRefreshableDiscordAttachmentUrl(url)) return "";
  try {
    const parsed = new URL(url);
    return `https://cdn.discordapp.com${parsed.pathname}`;
  } catch {
    return "";
  }
}

function normalizeAuthToken(token) {
  return token.trim();
}

async function refreshDiscordUrls() {
  if (!state.raw) {
    els.status.textContent = "Load a JSON file before refreshing URLs.";
    return;
  }

  const token = requireDiscordToken();
  if (!token) return;

  const urls = collectDiscordAttachmentUrls();
  if (!urls.length) {
    els.status.textContent = "No Discord attachment URLs found to refresh.";
    return;
  }

  const originalText = els.refreshUrls.textContent;
  els.refreshUrls.disabled = true;
  els.refreshUrls.textContent = "Refreshing...";
  const batches = chunkArray(urls, refreshBatchSize);
  els.status.textContent = `Refreshing ${urls.length} Discord URL${urls.length === 1 ? "" : "s"} in ${batches.length} batch${batches.length === 1 ? "" : "es"}...`;

  try {
    const refreshMap = new Map();

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      els.status.textContent = `Refreshing batch ${index + 1}/${batches.length} (${batch.length} URLs)...`;
      const payload = await postRefreshBatch(batch, token);
      const batchMap = buildRefreshMap(payload, batch);
      for (const [oldUrl, newUrl] of batchMap) refreshMap.set(oldUrl, newUrl);
      if (index < batches.length - 1) await wait(250);
    }

    if (!refreshMap.size) {
      throw new Error("Discord returned no recognizable refreshed URLs");
    }

    const replacements = replaceUrlsInJson(state.raw, refreshMap);
    await remountParsedJson(
      state.raw,
      state.fileName || "gifs.json",
      `Refreshed ${replacements} URL${replacements === 1 ? "" : "s"}. Preview remounted; use Download JSON to save the updated file.`
    );
  } catch (error) {
    els.status.textContent = `Could not refresh URLs: ${error.message}`;
  } finally {
    els.refreshUrls.textContent = originalText;
    updateTokenButtons();
  }
}

async function postRefreshBatch(urls, token) {
  const response = await fetch(refreshEndpoint, {
    method: "POST",
    headers: {
      "Authorization": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attachment_urls: urls }),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(describeDiscordError(payload) || `HTTP ${response.status}`);
  }
  return payload;
}

function describeDiscordError(payload) {
  if (!payload || typeof payload !== "object") return "";
  const details = [];

  const walkErrors = (value, path) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value._errors)) {
      value._errors.forEach((item) => {
        if (item?.message) details.push(`${path}: ${item.message}`);
      });
    }
    Object.entries(value).forEach(([key, item]) => {
      if (key !== "_errors") walkErrors(item, path ? `${path}.${key}` : key);
    });
  };

  walkErrors(payload.errors, "");
  return [payload.message, ...details].filter(Boolean).join(" - ") || payload.error || "";
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function buildRefreshMap(payload, originals) {
  const map = new Map();
  const originalSet = new Set(originals);

  const addPair = (oldUrl, newUrl) => {
    if (!oldUrl || !newUrl || oldUrl === newUrl) return;
    if (originalSet.has(oldUrl) || isRefreshableDiscordAttachmentUrl(oldUrl)) {
      map.set(oldUrl, newUrl);
      const identity = attachmentIdentity(oldUrl);
      if (identity) map.set(`attachment:${identity}`, newUrl);
      const refreshedIdentity = attachmentIdentity(newUrl);
      if (refreshedIdentity) map.set(`attachment:${refreshedIdentity}`, newUrl);
    }
  };

  const visit = (value, fallbackOriginal = "") => {
    if (typeof value === "string") {
      addPair(fallbackOriginal, value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, originals[index] || ""));
      return;
    }

    if (!isObject(value)) return;

    const explicitOldUrl = value.original || value.original_url || value.originalUrl || value.old || value.old_url || value.oldUrl;
    const explicitNewUrl = value.refreshed || value.refreshed_url || value.refreshedUrl || value.new || value.new_url || value.newUrl || value.proxy_url || value.proxyUrl;
    const singleUrl = value.url || value.attachment_url || value.attachmentUrl;
    const oldUrl = explicitOldUrl || fallbackOriginal || singleUrl;
    const newUrl = explicitNewUrl || singleUrl;
    addPair(oldUrl, newUrl);

    Object.entries(value).forEach(([key, item]) => {
      if (typeof item === "string" && isRefreshableDiscordAttachmentUrl(key)) {
        addPair(key, item);
      } else if (key !== "original" && key !== "original_url" && key !== "old" && key !== "old_url") {
        visit(item, fallbackOriginal);
      }
    });
  };

  visit(payload);
  return map;
}

function replaceUrlsInJson(value, refreshMap) {
  let replacements = 0;

  const replaceValue = (current) => {
    if (typeof current === "string") {
      const replacement = replacementForUrl(current, refreshMap);
      if (replacement) {
        replacements += 1;
        return replacement;
      }
      return current;
    }

    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        current[index] = replaceValue(item);
      });
      return current;
    }

    if (isObject(current)) {
      for (const key of Object.keys(current)) {
        const nextKey = replacementForUrl(key, refreshMap) || key;
        const nextValue = replaceValue(current[key]);
        if (nextKey !== key) {
          delete current[key];
          replacements += 1;
        }
        current[nextKey] = nextValue;
      }
    }

    return current;
  };

  replaceValue(value);
  return replacements;
}

function replacementForUrl(url, refreshMap) {
  if (!url) return "";
  const exact = refreshMap.get(url);
  if (exact) return exact;
  const identity = attachmentIdentity(url);
  return identity ? refreshMap.get(`attachment:${identity}`) || "" : "";
}

function attachmentIdentity(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes("/attachments/")) return "";
    return parsed.pathname;
  } catch {
    return "";
  }
}

function downloadRefreshedJson() {
  if (!state.raw) {
    els.status.textContent = "Load a JSON file before downloading.";
    return;
  }
  const name = state.fileName || "gifs.json";
  const blob = new Blob([`${JSON.stringify(state.raw, null, 2)}\n`], { type: "application/json" });
  downloadBlob(blob, name);
  els.status.textContent = `${name} download started.`;
}

function renderMetadata(item) {
  const rows = [
    ["Format", item.format],
    ["Source host", getHost(item.href || item.src) || "unknown"],
    ["Original URL", item.href],
  ];

  for (const [key, value] of Object.entries(item.raw || {})) {
    if (["format", "src", "width", "height", "slot"].includes(key)) continue;
    if (value === undefined || value === null) continue;
    if (isObject(value)) continue;
    const label = labelFromKey(key);
    const display = formatMetaValue(key, value);
    if (!rows.some(([existingLabel]) => existingLabel.toLowerCase() === label.toLowerCase())) {
      rows.push([label, display]);
    }
  }

  return rows.map(([label, value]) => `
    <div class="meta-item">
      <span>${escapeHtml(label)}</span>
      <code title="${escapeAttr(value)}">${escapeHtml(value)}</code>
    </div>
  `).join("");
}

function labelFromKey(key) {
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMetaValue(key, value) {
  if (Array.isArray(value)) return value.join(", ");
  const date = timestampToDate(key, value);
  if (date) return `${date.toLocaleString()} (${value})`;
  return String(value);
}

function timestampToDate(key, value) {
  if (!/(date|time|created|updated|added|favorite|favour|used|timestamp|at)$/i.test(key)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const milliseconds = number > 100000000000 ? number : number * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function saveGif(item, button) {
  const directGifUrl = getGifCandidates(item)[0];
  if (directGifUrl) {
    downloadUrl(directGifUrl, exportFileName(item, directGifUrl));
    els.status.textContent = "GIF download started.";
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "GIF...";
  try {
    els.status.textContent = "Converting to GIF...";
    const blob = item.format === "VIDEO"
      ? await convertVideoToGif(item)
      : await convertImageToGif(item);
    downloadBlob(blob, exportFileName(item));
    els.status.textContent = "Converted GIF download started.";
  } catch (error) {
    els.status.textContent = `Could not convert to GIF: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function downloadUrl(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "media.gif";
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, fileName);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

function exportFileName(item, directUrl = "") {
  const originalName = fileNameFromUrl(item.href);
  const directName = fileNameFromUrl(directUrl);
  const previewName = fileNameFromUrl(item.src);
  const base = stripExtension(originalName || directName || previewName || "media");
  const safe = base.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "media";
  return `${safe}.gif`;
}

function displayFileName(item) {
  return fileNameFromUrl(item.href) || fileNameFromUrl(item.src) || getHost(item.href || item.src) || "media";
}

function stripExtension(name) {
  return String(name).replace(/\.[a-z0-9]{1,8}$/i, "");
}

function mediaUrl(item) {
  return item.src || item.href;
}

async function fetchMediaBlob(item) {
  const url = mediaUrl(item);
  if (!url) throw new Error("no media URL found");
  const response = await fetch(url, { mode: "cors", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

function scaledSize(width, height, maxSide = 360) {
  const sourceWidth = Math.max(1, width || 320);
  const sourceHeight = Math.max(1, height || 320);
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

async function convertImageToGif(item) {
  const blob = await fetchMediaBlob(item);
  const bitmap = await createImageBitmap(blob);
  const size = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  const pixels = context.getImageData(0, 0, size.width, size.height).data;
  return encodeGifBlob([{ pixels, delay: 1000 }], size.width, size.height);
}

async function convertVideoToGif(item) {
  const blob = await fetchMediaBlob(item);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = objectUrl;
    await waitForEvent(video, "loadedmetadata");
    if (video.readyState < 2) await waitForEvent(video, "loadeddata");

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(video.duration, 6) : 2;
    const fps = 10;
    const frameCount = Math.max(2, Math.min(60, Math.ceil(duration * fps)));
    const delay = Math.round(1000 / fps);
    const size = scaledSize(video.videoWidth || item.width, video.videoHeight || item.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const frames = [];

    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = frameCount === 1 ? 0 : frame * duration / frameCount;
      els.status.textContent = `Converting video to GIF... ${frame + 1}/${frameCount}`;
      await seekVideo(video, time);
      context.drawImage(video, 0, 0, size.width, size.height);
      const pixels = context.getImageData(0, 0, size.width, size.height).data;
      frames.push({ pixels: new Uint8ClampedArray(pixels), delay });
    }

    return encodeGifBlob(frames, size.width, size.height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function encodeGifBlob(frames, width, height) {
  return new Blob([encodeGif(frames, width, height)], { type: "image/gif" });
}

function encodeGif(frames, width, height) {
  const bytes = [];
  const push = (...values) => bytes.push(...values);
  const pushAscii = (text) => {
    for (let index = 0; index < text.length; index += 1) bytes.push(text.charCodeAt(index));
  };
  const pushLe16 = (value) => push(value & 255, value >> 8 & 255);

  pushAscii("GIF89a");
  pushLe16(width);
  pushLe16(height);
  push(0, 0, 0);

  if (frames.length > 1) {
    push(0x21, 0xff, 0x0b);
    pushAscii("NETSCAPE2.0");
    push(0x03, 0x01, 0x00, 0x00, 0x00);
  }

  for (const frame of frames) {
    const palette = makePalette();
    const indexed = indexPixels(frame.pixels);
    const delayCs = Math.max(2, Math.round((frame.delay || 100) / 10));

    push(0x21, 0xf9, 0x04, 0x04);
    pushLe16(delayCs);
    push(0x00, 0x00);

    push(0x2c);
    pushLe16(0);
    pushLe16(0);
    pushLe16(width);
    pushLe16(height);
    push(0x87);
    push(...palette);

    push(8);
    writeSubBlocks(bytes, lzwEncode(indexed, 8));
  }

  push(0x3b);
  return new Uint8Array(bytes);
}

function makePalette() {
  const palette = [];
  const levels = [0, 51, 102, 153, 204, 255];
  for (const red of levels) {
    for (const green of levels) {
      for (const blue of levels) {
        palette.push(red, green, blue);
      }
    }
  }
  while (palette.length < 256 * 3) palette.push(0, 0, 0);
  return palette;
}

function indexPixels(pixels) {
  const indexed = new Uint8Array(pixels.length / 4);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    const alpha = pixels[source + 3];
    if (alpha < 16) {
      indexed[target] = 0;
      continue;
    }
    const red = Math.min(5, Math.round(pixels[source] / 51));
    const green = Math.min(5, Math.round(pixels[source + 1] / 51));
    const blue = Math.min(5, Math.round(pixels[source + 2] / 51));
    indexed[target] = red * 36 + green * 6 + blue;
  }
  return indexed;
}

function writeSubBlocks(bytes, data) {
  for (let offset = 0; offset < data.length; offset += 255) {
    const block = data.slice(offset, offset + 255);
    bytes.push(block.length, ...block);
  }
  bytes.push(0);
}

function lzwEncode(indexed, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  let current = "";
  const dictionary = new Map();
  const output = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const resetDictionary = () => {
    dictionary.clear();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  const writeCode = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bitBuffer & 255);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const codeFor = (key) => key.includes(",") ? dictionary.get(key) : Number(key);

  writeCode(clearCode);
  for (const value of indexed) {
    const symbol = String(value);
    const candidate = current ? `${current},${symbol}` : symbol;
    if (!current || dictionary.has(candidate)) {
      current = candidate;
      continue;
    }

    writeCode(codeFor(current));
    if (nextCode < 4096) {
      dictionary.set(candidate, nextCode);
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      writeCode(clearCode);
      resetDictionary();
    }
    current = symbol;
  }

  if (current) writeCode(codeFor(current));
  writeCode(endCode);
  if (bitCount > 0) output.push(bitBuffer & 255);
  return new Uint8Array(output);
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("media failed to load"));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const targetTime = Math.max(0, Math.min(time, video.duration || time));
    if (video.readyState >= 2 && Math.abs(video.currentTime - targetTime) < 0.03) {
      requestAnimationFrame(resolve);
      return;
    }
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("video seek failed"));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = targetTime;
  });
}

function stripDiscordImageFormat(url) {
  if (!url || !url.includes("format=webp")) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("format");
    parsed.searchParams.delete("animated");
    return parsed.toString();
  } catch {
    return url.replace(/[?&]format=webp/g, "").replace(/[?&]animated=true/g, "");
  }
}

function getHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

els.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
els.targetFileInput.addEventListener("change", (event) => loadTargetFile(event.target.files[0]));
els.discordToken.addEventListener("input", () => {
  updateTokenButtons();
  updateSelectedButtons();
});
els.targetDiscordToken.addEventListener("input", () => {
  updateTokenButtons();
  updateSelectedButtons();
});
els.search.addEventListener("input", renderMedia);
els.formatFilter.addEventListener("change", renderMedia);
els.sort.addEventListener("change", renderMedia);
els.selectMenu.addEventListener("change", applySelectionMenu);
els.fetchSettings.addEventListener("click", fetchSettingsProto);
els.refreshUrls.addEventListener("click", refreshDiscordUrls);
els.removeFailed.addEventListener("click", removeFailedMedia);
els.removeSelected.addEventListener("click", removeSelectedMedia);
els.patchSelected.addEventListener("click", () => patchDiscordSettings(true));
els.patchDiscord.addEventListener("click", () => patchDiscordSettings(false));
els.downloadJson.addEventListener("click", downloadRefreshedJson);
els.mediaGrid.addEventListener("click", handleMediaAction);
els.mediaGrid.addEventListener("change", handleSelectionChange);
els.mediaGrid.addEventListener("dragstart", handleDragStart);
els.mediaGrid.addEventListener("dragover", handleDragOver);
els.mediaGrid.addEventListener("dragleave", handleDragLeave);
els.mediaGrid.addEventListener("drop", handleDrop);
els.mediaGrid.addEventListener("dragend", handleDragEnd);
els.mediaGrid.addEventListener("pointerdown", handlePointerDown);
els.mediaGrid.addEventListener("pointermove", handlePointerMove);
document.addEventListener("pointerup", handlePointerUp);

["dragenter", "dragover"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragging");
  });
});

els.dropzone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));
render();
tryAutoload();
