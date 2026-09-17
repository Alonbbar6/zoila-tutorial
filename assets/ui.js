// Shared browser helpers for index.html, guia.html and admin.html.

const MARKED_URL = "https://cdn.jsdelivr.net/npm/marked@18.0.13/lib/marked.esm.js";
const PURIFY_URL = "https://cdn.jsdelivr.net/npm/dompurify@3.4.15/dist/purify.es.mjs";

// ---------- text ----------

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Tiny element builder: el("p", {class: "x", text: "hi"}, child1, child2)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------- markdown (tutor answers only; student text is always plain text) ----------

let mdLibs = null;
function loadMarkdown() {
  if (!mdLibs) {
    mdLibs = Promise.all([import(MARKED_URL), import(PURIFY_URL)])
      .then(([markedMod, purifyMod]) => {
        const marked = markedMod.marked;
        marked.setOptions({ gfm: true, breaks: true });
        return { marked, purify: purifyMod.default };
      })
      .catch(() => null);
  }
  return mdLibs;
}

// Returns a DocumentFragment. Falls back to plain text if the CDN is unreachable.
export async function renderMarkdown(text) {
  const libs = await loadMarkdown();
  const frag = document.createDocumentFragment();
  if (!libs) {
    frag.append(el("p", { class: "md-plain", text }));
    return frag;
  }
  const html = libs.purify.sanitize(libs.marked.parse(String(text ?? "")), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "img"],
    FORBID_ATTR: ["style"],
  });
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  frag.append(tpl.content);
  return frag;
}

// ---------- time ----------

export function timeAgo(iso, lang = "es") {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 45) return lang === "es" ? "justo ahora" : "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 604800) return rtf.format(Math.round(seconds / 86400), "day");
  return new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
}

export function fullDate(iso, lang = "es") {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
}

// ---------- storage (never throws) ----------

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

// Reads `#name=value` from the URL hash, then removes it from the visible URL.
export function takeHashParam(name) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const value = params.get(name);
  if (value) {
    params.delete(name);
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  }
  return value;
}

// ---------- attention ----------

const baseTitle = document.title;
export function setTitleBadge(count) {
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}

let audioCtx = null;
export function chime() {
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    audioCtx = audioCtx || new AudioContext();
    const now = audioCtx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.08, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });
  } catch {}
}

export async function askNotificationPermission() {
  try {
    if (!("Notification" in window)) return "unsupported";
    if (Notification.permission === "default") return await Notification.requestPermission();
    return Notification.permission;
  } catch {
    return "denied";
  }
}

export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
      new Notification(title, { body });
    }
  } catch {}
}

// Screen-reader announcement through a shared polite live region.
export function announce(message) {
  let region = document.getElementById("sr-live");
  if (!region) {
    region = el("div", { id: "sr-live", class: "sr-only", "aria-live": "polite", "aria-atomic": "true" });
    document.body.append(region);
  }
  region.textContent = "";
  setTimeout(() => (region.textContent = message), 50);
}

// Small toast at the bottom of the screen.
export function toast(message, { tone = "info", ms = 3200 } = {}) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = el("div", { id: "toasts", class: "toasts" });
    document.body.append(host);
  }
  const item = el("div", { class: `toast toast-${tone}`, role: tone === "error" ? "alert" : "status", text: message });
  host.append(item);
  setTimeout(() => item.remove(), ms);
}

// ---------- polling ----------

// Runs fn now and then every `seconds` while the tab is visible. Returns {refresh, stop}.
export function poll(fn, seconds) {
  let timer = null;
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    clearInterval(timer);
    if (!stopped && document.visibilityState === "visible") timer = setInterval(tick, seconds * 1000);
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") tick();
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", tick);
  tick();
  schedule();
  return {
    refresh: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", tick);
    },
  };
}

// Copies text; returns true on success.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { readonly: true, class: "sr-only" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}
