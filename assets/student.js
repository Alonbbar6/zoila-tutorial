// Student site: the list of conversations, the compose form and each conversation.
// Everything the student reads is Spanish (tú). Her own text is always rendered as plain
// text; tutor answers go through ui.renderMarkdown, which sanitizes them.

import { CONFIG, isConfigured } from "./config.js";
import { call } from "./api.js";
import {
  el,
  renderMarkdown,
  timeAgo,
  fullDate,
  store,
  takeHashParam,
  setTitleBadge,
  chime,
  askNotificationPermission,
  notify,
  announce,
  toast,
  poll,
} from "./ui.js";

const TOKEN_KEY = "tutor.sala";
const TUTOR_NAME_KEY = "tutor.nombre";
const DRAFT_KEY = "tutor.borrador";

// Same limits the backend enforces (SPEC §1).
const LIMITS = { title: 140, text: 8000, code: 8000 };

const TOPIC_LABELS = {
  powerbi: "Power BI",
  powerquery: "Power Query",
  dax: "DAX",
  python: "Python",
  error: "Un error",
  otro: "Otro",
};

const STATUS_LABELS = {
  waiting: "Esperando respuesta",
  answering: "El tutor está escribiendo…",
  answered: "Respondida",
  closed: "Resuelta",
};

// Shown when she has no conversations yet; clicking one prefills the form.
const EXAMPLES = [
  {
    topic: "powerbi",
    title: "¿Cuándo uso una columna y cuándo una medida?",
    text:
      "Estoy en la Etapa 1. Ya cargué ventas.csv en Power BI y creé la medida Total Ventas, " +
      "pero no entiendo bien la diferencia entre una columna y una medida. ¿Me lo explicas con un ejemplo de la vida diaria?",
    code: "",
  },
  {
    topic: "python",
    title: "¿Cómo saco el total vendido por ciudad con pandas?",
    text:
      "Estoy en la Etapa 3. Ya sé sacar el total por producto, pero no sé qué tengo que cambiar " +
      "para verlo por ciudad. ¿Me das una pista sin darme la solución completa?",
    code: 'por_producto = tabla.groupby("producto")["total"].sum()\nprint(por_producto)',
  },
  {
    topic: "error",
    title: "Me sale KeyError y no sé qué significa",
    text:
      "Quise crear la columna total y Python me mostró este error en rojo. " +
      "Revisé el archivo y la columna sí existe. ¿Qué estoy haciendo mal?",
    code:
      "Traceback (most recent call last):\n" +
      '  File "analisis.py", line 6, in <module>\n' +
      '    tabla["total"] = tabla["Cantidad"] * tabla["precio"]\n' +
      "KeyError: 'Cantidad'",
  },
];

// [input id, counter id, limit, count the trimmed value?]
const COUNTERS = [
  ["f-title", "count-title", LIMITS.title, true],
  ["f-text", "count-text", LIMITS.text, true],
  ["f-code", "count-code", LIMITS.code, false],
  ["r-text", "count-r-text", LIMITS.text, true],
  ["r-code", "count-r-code", LIMITS.code, false],
];

const VIEWS = ["loading", "nolink", "notconfigured", "error", "home", "compose", "thread"];

const state = {
  room: null,
  info: null, // {studentName, tutorName, auto:{question, direct}}
  view: null,
  threads: [], // latest `list` result
  seen: new Map(), // id -> messageCount from the previous poll, to spot new answers
  listLoaded: false,
  openId: null, // thread shown in the thread view
  openThread: null, // its last rendered data
  threadSeq: 0, // bumps on every thread load so stale responses are dropped
  focusThreadTitle: false,
  failures: 0,
  poller: null,
  hiddenTimer: null,
  sending: false,
  replying: false,
  draftTimer: null,
};

const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------

function tutorName() {
  const remembered = store.get(TUTOR_NAME_KEY);
  return state.info?.tutorName || (typeof remembered === "string" && remembered) || "tu tutor";
}

function initial(name) {
  const first = [...String(name || "").trim()][0];
  return first ? first.toUpperCase() : "?";
}

// Puts a space between inline items so screen readers don't glue the words together.
function spaced(...items) {
  const out = [];
  for (const item of items.flat()) {
    if (!item) continue;
    if (out.length) out.push(" ");
    out.push(item);
  }
  return out;
}

function statusPill(status) {
  const known = Object.hasOwn(STATUS_LABELS, status) ? status : "waiting";
  return el("span", { class: `pill pill-${known}` }, STATUS_LABELS[known]);
}

function kindLabel(kind) {
  return kind === "direct" ? `Mensaje a ${tutorName()}` : "Pregunta";
}

function topicLabel(topic) {
  return Object.hasOwn(TOPIC_LABELS, topic) ? TOPIC_LABELS[topic] : "Otro";
}

function timeEl(iso) {
  return el("time", { datetime: iso, title: fullDate(iso), "data-ago": iso }, timeAgo(iso));
}

function refreshTimes() {
  for (const node of document.querySelectorAll("time[data-ago]")) {
    node.textContent = timeAgo(node.getAttribute("data-ago"));
  }
}

// Keeps the first line's indentation; drops blank lines around the code.
function cleanCode(value) {
  if (!value.trim()) return "";
  return value.replace(/^(\s*\n)+/, "").replace(/\s+$/, "");
}

function errorMessage(err, { sending = false } = {}) {
  switch (err?.code) {
    case "rate_limited":
      return "Enviaste muchos mensajes en poco tiempo. Descansa un rato y vuelve a intentarlo más tarde (como mucho, en una hora).";
    case "network":
      return "No pudimos conectar con el sitio. Revisa tu conexión a internet y vuelve a intentarlo.";
    case "timeout":
      return sending
        ? "El sitio tardó demasiado en responder. Puede que tu mensaje sí haya llegado: revisa «Mis preguntas» antes de enviarlo otra vez."
        : "El sitio tardó demasiado en responder. Espera un momento y vuelve a intentarlo.";
    case "unauthorized":
      return `Tu enlace ya no funciona. Pídele a ${tutorName()} uno nuevo.`;
    case "bad_request":
      return "Revisa lo que escribiste: puede que falte algo o que sea demasiado largo.";
    case "not_found":
      return "No encontramos esta conversación. Puede que se haya borrado.";
    case "not_configured":
      return `El sitio todavía no está conectado del todo. Avísale a ${tutorName()}.`;
    default:
      return "Algo salió mal. Vuelve a intentarlo en un momento.";
  }
}

// role="alert" boxes: clear first so the same message is announced again.
function showFormError(boxId, message, field) {
  const box = $(boxId);
  box.textContent = "";
  setTimeout(() => (box.textContent = message), 30);
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.focus();
  }
}

function clearFormError(boxId) {
  $(boxId).textContent = "";
}

function updateCounters() {
  for (const [inputId, counterId, limit, trim] of COUNTERS) {
    const value = $(inputId).value;
    const count = (trim ? value.trim() : value).length;
    const counter = $(counterId);
    counter.replaceChildren(`${count} / ${limit}`, el("span", { class: "sr-only" }, " caracteres"));
    counter.classList.toggle("over", count > limit);
  }
}

// Fills every [data-tutor] placeholder and the texts that depend on the settings.
function applyNames() {
  const tutor = tutorName();
  for (const node of document.querySelectorAll("[data-tutor]")) node.textContent = tutor;
  $("greeting").textContent = state.info ? `Hola, ${state.info.studentName}` : "Tutor IA";
  const autoQuestion = state.info?.auto?.question !== false;
  $("action-question-sub").textContent = autoQuestion
    ? "Te responde el Tutor IA, normalmente en más o menos un minuto."
    : `Te responden en cuanto puedan. ${tutor} revisa cada pregunta.`;
  $("kind-question-sub").textContent = autoQuestion
    ? "Responde en más o menos un minuto."
    : "Te responden en cuanto puedan.";
  applyKind();
}

// ---------- views and routing ----------

function showView(name, { focus = false } = {}) {
  const changed = state.view !== name;
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  state.view = name;
  const navHome = $("nav-home");
  if (name === "home") navHome.setAttribute("aria-current", "page");
  else navHome.removeAttribute("aria-current");
  if (changed) window.scrollTo(0, 0);
  if (focus) $(`view-${name}`).querySelector("h1")?.focus({ preventScroll: true });
  updateBadge();
}

// URL shapes: index.html (list) · ?nueva=pregunta|directo (compose) · ?hilo=<id> (thread)
function route({ focus = true, example = null } = {}) {
  if (!state.info) return;
  const params = new URLSearchParams(location.search);
  const threadId = params.get("hilo");
  if (threadId) openThread(threadId, focus);
  else if (params.has("nueva")) openCompose(params.get("nueva") === "directo" ? "direct" : "question", example, focus);
  else openHome(focus);
}

function navigate(search, options = {}) {
  const url = location.pathname + search;
  if (location.search === search) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  route({ focus: true, ...options });
}

// In-app links keep working as normal links (new tab, no JS), but navigate without a reload.
function onRouteClick(ev) {
  const link = ev.target.closest?.("a[data-route]");
  if (!link || !state.info) return;
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  navigate(link.getAttribute("data-route"));
}

function leaveThread() {
  state.openId = null;
  state.openThread = null;
  state.threadSeq++;
}

// ---------- boot ----------

function start() {
  // A fresh link (#sala=...) wins over the remembered one.
  const fromLink = takeHashParam("sala");
  if (fromLink) store.set(TOKEN_KEY, fromLink);
  const remembered = store.get(TOKEN_KEY);
  state.room = fromLink || (typeof remembered === "string" && remembered) || null;

  applyNames();
  if (!isConfigured()) return showView("notconfigured");
  if (!state.room) return showView("nolink");
  connect();
}

async function connect({ fromRetry = false } = {}) {
  stopPolling();
  showView("loading");
  let info;
  try {
    info = await call("info", { room: state.room });
  } catch (err) {
    if (err.code === "unauthorized") return signOut();
    $("error-text").textContent = errorMessage(err);
    showView("error");
    if (fromRetry) $("retry-btn").focus();
    return;
  }
  state.info = info || {};
  if (state.info.tutorName) store.set(TUTOR_NAME_KEY, state.info.tutorName);
  applyNames();
  $("nav-home").hidden = false;
  $("foot").hidden = false;
  route({ focus: fromRetry });
  startPolling();
}

// The room token was rejected: forget it and show the "open your link" screen.
function signOut() {
  stopPolling();
  store.remove(TOKEN_KEY);
  Object.assign(state, {
    room: null,
    info: null,
    threads: [],
    seen: new Map(),
    listLoaded: false,
    openId: null,
    openThread: null,
  });
  state.threadSeq++;
  const list = $("thread-list");
  list.replaceChildren();
  delete list.dataset.signature;
  $("nav-home").hidden = true;
  $("foot").hidden = true;
  $("conn").hidden = true;
  applyNames();
  showView("nolink", { focus: true });
  setTitleBadge(0);
}

function onHashChange() {
  const token = takeHashParam("sala");
  if (!token || token === state.room) return;
  store.set(TOKEN_KEY, token);
  state.room = token;
  if (isConfigured()) connect();
}

// ---------- polling and new-answer alerts ----------

function startPolling() {
  stopPolling();
  state.poller = poll(refresh, CONFIG.pollSeconds);
  // ui.poll pauses while the tab is hidden. If she allowed notifications, still check
  // once a minute so a desktop notification can reach her in another tab.
  state.hiddenTimer = setInterval(() => {
    const allowed = "Notification" in window && Notification.permission === "granted";
    if (allowed && document.visibilityState === "hidden") state.poller?.refresh();
  }, 60000);
}

function stopPolling() {
  state.poller?.stop();
  state.poller = null;
  clearInterval(state.hiddenTimer);
  state.hiddenTimer = null;
}

async function refresh() {
  const room = state.room;
  if (!room || !state.info) return;
  let result;
  try {
    result = await call("list", { room });
  } catch (err) {
    if (room !== state.room) return;
    if (err.code === "unauthorized") return signOut();
    state.failures++;
    if (state.failures >= 2) $("conn").hidden = false;
    return;
  }
  if (room !== state.room) return;
  state.failures = 0;
  $("conn").hidden = true;

  const threads = Array.isArray(result?.threads) ? result.threads : [];
  const news = state.listLoaded ? findNews(threads) : [];
  state.seen = new Map(threads.map((t) => [t.id, Number(t.messageCount) || 0]));
  state.threads = threads;
  state.listLoaded = true;

  if (state.view === "home") renderList();
  if (state.view === "thread") syncOpenThread();
  refreshTimes();
  updateBadge();
  if (news.length) announceNews(news);
}

// Threads whose newest message is a reply we had not seen in the previous poll.
function findNews(threads) {
  return threads.filter((t) => {
    if (t.lastFrom !== "tutor" && t.lastFrom !== "alon") return false;
    if (!state.seen.has(t.id)) return Boolean(t.unread); // e.g. an emailed question answered between polls
    return (Number(t.messageCount) || 0) > state.seen.get(t.id);
  });
}

function announceNews(news) {
  chime();
  const first = news[0];
  const author = first.lastFrom === "alon" ? tutorName() : "El Tutor IA";
  const what = first.kind === "direct" ? "tu mensaje" : "tu pregunta";
  const message =
    news.length === 1
      ? `${author} respondió ${what} #${first.number}: ${first.title}`
      : `Tienes ${news.length} respuestas nuevas.`;
  notify(
    news.length === 1 ? `${author} te respondió` : "Tienes respuestas nuevas",
    news.map((t) => `#${t.number} · ${t.title}`).join("\n"),
  );
  const viewingIt = state.view === "thread" && news.some((t) => t.id === state.openId);
  if (!viewingIt && document.visibilityState === "visible") {
    toast(message, { ms: 6000 }); // the toast is a role="status" region, so it is announced too
  } else {
    announce(message);
  }
}

function updateBadge() {
  const viewingId = state.view === "thread" && document.visibilityState === "visible" ? state.openId : null;
  setTitleBadge(state.threads.filter((t) => t.unread && t.id !== viewingId).length);
}

function updateNotifyButtons() {
  const canAsk = "Notification" in window && Notification.permission !== "granted";
  $("notify-btn").hidden = !canAsk;
  const status = state.openThread?.status;
  $("notify-btn-thread").hidden = !canAsk || !(status === "waiting" || status === "answering");
}

async function enableNotifications(ev) {
  const button = ev.currentTarget; // read before awaiting: currentTarget is cleared afterwards
  const result = await askNotificationPermission();
  if (result === "granted") {
    toast("Listo. Te avisaremos cuando llegue una respuesta, aunque estés en otra pestaña.", { ms: 5000 });
  } else if (result === "denied") {
    toast("Tu navegador tiene los avisos bloqueados. Puedes permitirlos desde el candado junto a la dirección de la página.", { ms: 8000 });
  }
  updateNotifyButtons();
  // If the button disappeared, keep keyboard focus in a sensible place.
  if (button.hidden) $(`view-${state.view}`).querySelector("h1")?.focus({ preventScroll: true });
}

// Fires the automatic answer without making her wait; polling shows the progress.
function fireProcess(id) {
  const room = state.room;
  call("process", { room, id }, { timeoutMs: 120000 })
    .catch(() => {})
    .finally(() => {
      if (room === state.room) state.poller?.refresh();
    });
}

// ---------- home ----------

function openHome(focus) {
  leaveThread();
  showView("home", { focus });
  renderList();
  updateNotifyButtons();
}

function renderList() {
  const host = $("thread-list");
  if (!state.listLoaded) {
    if (!host.firstChild) {
      host.replaceChildren(
        el("div", { class: "threads-loading", "aria-hidden": "true" },
          el("div", { class: "skeleton" }), el("div", { class: "skeleton" }), el("div", { class: "skeleton" })),
      );
    }
    return;
  }
  // Only rebuild when something visible changed, so keyboard focus isn't lost every poll.
  const signature = JSON.stringify(
    state.threads.map((t) => [t.id, t.number, t.title, t.kind, t.topic, t.status, t.unread, t.updatedAt]),
  );
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;

  const count = state.threads.length;
  $("list-count").textContent = count ? `${count} ${count === 1 ? "conversación" : "conversaciones"}` : "";
  if (!count) {
    host.replaceChildren(emptyState());
    return;
  }
  const focusedId = document.activeElement?.closest?.("[data-thread-id]")?.getAttribute("data-thread-id");
  host.replaceChildren(el("ul", { class: "threads" }, state.threads.map(threadRow)));
  if (focusedId) {
    for (const link of host.querySelectorAll("[data-thread-id]")) {
      if (link.getAttribute("data-thread-id") === focusedId) link.focus();
    }
  }
}

function threadRow(t) {
  const href = `?hilo=${encodeURIComponent(t.id)}`;
  return el("li", {},
    el("a", { class: t.unread ? "row is-unread" : "row", href, "data-route": href, "data-thread-id": t.id },
      el("span", { class: "row-num num", "aria-hidden": "true" }, `#${t.number}`),
      el("span", { class: "row-main" },
        el("span", { class: "row-title" },
          spaced(
            el("span", { class: "sr-only" }, `Número ${t.number}.`),
            t.title,
            t.unread && el("span", { class: "badge-new" }, "Nueva respuesta"),
          )),
        el("span", { class: "row-meta" },
          spaced(
            statusPill(t.status),
            el("span", {}, kindLabel(t.kind)),
            t.kind !== "direct" && el("span", { class: "tag" }, topicLabel(t.topic)),
            timeEl(t.updatedAt),
          )))));
}

function emptyState() {
  return el("div", { class: "empty" },
    el("p", { class: "empty-title" }, "Aquí aparecerán tus preguntas"),
    el("p", { class: "hint" }, "¿No sabes por dónde empezar? Elige un ejemplo, cámbialo con tus palabras y envíalo."),
    el("ul", { class: "examples" },
      EXAMPLES.map((example) =>
        el("li", {},
          el("button", { type: "button", class: "example", onclick: () => navigate("?nueva=pregunta", { example }) },
            spaced(
              el("span", { class: "sr-only" }, "Usar el ejemplo:"),
              el("span", { class: "tag" }, topicLabel(example.topic)),
              el("span", { class: "example-title" }, example.title),
            ))))));
}

// ---------- compose ----------

function selectedKind() {
  return $("kind-direct").checked ? "direct" : "question";
}

function composeSubmitLabel() {
  return selectedKind() === "direct" ? "Enviar mensaje" : "Enviar pregunta";
}

function setKind(kind) {
  $("kind-question").checked = kind !== "direct";
  $("kind-direct").checked = kind === "direct";
  applyKind();
}

function applyKind() {
  const direct = selectedKind() === "direct";
  $("field-topic").hidden = direct;
  $("compose-title").textContent = direct ? `Mensaje para ${tutorName()}` : "Nueva pregunta";
  $("label-text").textContent = direct ? "Tu mensaje" : "Tu pregunta";
  $("hint-title").textContent = direct
    ? "Una frase corta sobre lo que quieres contar."
    : "Una frase corta. Por ejemplo: «No me sale el total por ciudad».";
  if (!state.sending) $("compose-submit").textContent = composeSubmitLabel();
}

function composeIsEmpty() {
  return !$("f-title").value && !$("f-text").value && !$("f-code").value;
}

function fillCompose(data) {
  setKind(data.kind === "direct" ? "direct" : "question");
  $("f-topic").value = Object.hasOwn(TOPIC_LABELS, data.topic) ? data.topic : "";
  $("f-title").value = String(data.title || "");
  $("f-text").value = String(data.text || "");
  $("f-code").value = String(data.code || "");
  updateCounters();
}

function resetCompose() {
  const form = $("compose-form");
  form.reset();
  for (const field of form.querySelectorAll("[aria-invalid]")) field.removeAttribute("aria-invalid");
  $("draft-note").hidden = true;
  clearFormError("compose-error");
  applyKind();
  updateCounters();
}

function openCompose(kind, example, focus) {
  leaveThread();
  clearFormError("compose-error");
  $("draft-note").hidden = true;
  if (example) {
    fillCompose({ ...example, kind: "question" });
  } else if (composeIsEmpty()) {
    // Bring back what she was writing before closing the page.
    const draft = store.get(DRAFT_KEY);
    if (draft && typeof draft === "object" && (draft.title || draft.text || draft.code)) {
      fillCompose(draft);
      $("draft-note").hidden = false;
    }
  }
  setKind(example ? "question" : kind);
  showView("compose", { focus });
}

function saveDraftSoon() {
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    const draft = {
      kind: selectedKind(),
      topic: $("f-topic").value,
      title: $("f-title").value,
      text: $("f-text").value,
      code: $("f-code").value,
    };
    if (draft.title.trim() || draft.text.trim() || draft.code.trim()) store.set(DRAFT_KEY, draft);
    else store.remove(DRAFT_KEY);
  }, 400);
}

function onComposeInput(ev) {
  if (ev.target.getAttribute?.("aria-invalid")) {
    ev.target.removeAttribute("aria-invalid");
    clearFormError("compose-error");
  }
  updateCounters();
  saveDraftSoon();
}

function onComposeChange(ev) {
  if (ev.target.name === "kind") {
    applyKind();
    clearFormError("compose-error");
    // Keep the URL in step so a reload or "back" lands on the same kind.
    const search = selectedKind() === "direct" ? "?nueva=directo" : "?nueva=pregunta";
    if (location.search !== search) history.replaceState(null, "", location.pathname + search);
  }
  saveDraftSoon();
}

function clearDraft() {
  clearTimeout(state.draftTimer);
  store.remove(DRAFT_KEY);
  const kind = selectedKind();
  resetCompose();
  setKind(kind);
  $(kind === "direct" ? "f-title" : "f-topic").focus();
}

function setComposeSending(sending) {
  state.sending = sending;
  const button = $("compose-submit");
  button.disabled = sending;
  button.textContent = sending ? "Enviando…" : composeSubmitLabel();
  $("compose-form").setAttribute("aria-busy", String(sending));
}

async function submitCompose(ev) {
  ev.preventDefault();
  if (state.sending) return;
  const kind = selectedKind();
  const direct = kind === "direct";
  const topicEl = $("f-topic");
  const titleEl = $("f-title");
  const textEl = $("f-text");
  const codeEl = $("f-code");
  const topic = direct ? "otro" : topicEl.value;
  const title = titleEl.value.trim();
  const text = textEl.value.trim();
  const code = cleanCode(codeEl.value);

  let problem = null;
  if (!direct && !Object.hasOwn(TOPIC_LABELS, topic)) {
    problem = [topicEl, "Elige un tema. Si no sabes cuál, elige «Otro»."];
  } else if (!title) {
    problem = [titleEl, "Escribe un título corto."];
  } else if (title.length > LIMITS.title) {
    problem = [titleEl, `El título es un poco largo: máximo ${LIMITS.title} caracteres (ahora tiene ${title.length}).`];
  } else if (!text) {
    problem = [textEl, direct ? "Escribe tu mensaje." : "Escribe tu pregunta."];
  } else if (text.length > LIMITS.text) {
    problem = [textEl, `El texto es muy largo: máximo ${LIMITS.text} caracteres (ahora tiene ${text.length}). Puedes enviarlo en dos partes.`];
  } else if (code.length > LIMITS.code) {
    problem = [codeEl, `El código es muy largo: máximo ${LIMITS.code} caracteres. Pega solo la parte que falla y el mensaje de error.`];
  }
  if (problem) return showFormError("compose-error", problem[1], problem[0]);

  clearFormError("compose-error");
  setComposeSending(true);
  try {
    const { thread } = await call("create", { room: state.room, kind, topic, title, text, code });
    clearTimeout(state.draftTimer);
    store.remove(DRAFT_KEY);
    resetCompose();
    fireProcess(thread.id);
    // Replace the compose entry so "back" returns to the list, not to an empty form.
    history.replaceState(null, "", `${location.pathname}?hilo=${encodeURIComponent(thread.id)}`);
    route({ focus: true });
    state.poller?.refresh();
  } catch (err) {
    if (err?.code === "unauthorized") return signOut();
    showFormError("compose-error", errorMessage(err, { sending: true }));
  } finally {
    setComposeSending(false);
  }
}

// ---------- thread ----------

function openThread(id, focus) {
  if (state.openId !== id) {
    state.openId = id;
    state.openThread = null;
    resetThreadView(id);
  }
  state.focusThreadTitle = focus;
  showView("thread");
  loadThread(id);
}

function resetThreadView(id) {
  const listed = state.threads.find((t) => t.id === id);
  if (listed) {
    renderThreadHead(listed);
  } else {
    $("thread-num").textContent = "";
    $("thread-title").textContent = "Cargando…";
    $("thread-meta").replaceChildren();
  }
  $("messages").replaceChildren(
    el("li", { class: "skeleton", "aria-hidden": "true" }),
    el("li", { class: "skeleton", "aria-hidden": "true" }),
  );
  const status = $("thread-status");
  status.replaceChildren();
  delete status.dataset.key;
  clearFormError("thread-error");
  $("thread-retry").hidden = true;
  $("resolve-row").hidden = true;
  $("closed-note").hidden = true;
  $("notify-btn-thread").hidden = true;

  // Keep a half-written follow-up only if it belongs to this same thread.
  const reply = $("reply-form");
  reply.hidden = true;
  if (reply.dataset.threadId !== id) {
    reply.reset();
    reply.dataset.threadId = id;
    $("r-code-box").open = false;
    clearFormError("reply-error");
    updateCounters();
  }
}

async function loadThread(id, { quiet = false } = {}) {
  const seq = ++state.threadSeq;
  let data;
  try {
    data = await call("thread", { room: state.room, id });
  } catch (err) {
    if (seq !== state.threadSeq || state.openId !== id) return;
    if (err.code === "unauthorized") return signOut();
    if (err.code === "not_found") return renderThreadMissing();
    if (!quiet || !state.openThread) {
      $("messages").replaceChildren();
      showFormError("thread-error", errorMessage(err));
      $("thread-retry").hidden = false;
    }
    return;
  }
  if (seq !== state.threadSeq || state.openId !== id) return;
  const shown = await renderThread(data.thread, Array.isArray(data.messages) ? data.messages : [], seq);
  if (!shown) return;

  // Opening the thread marked it as read on the server; mirror that locally.
  const listed = state.threads.find((t) => t.id === id);
  if (listed) listed.unread = false;
  updateBadge();
  if (state.focusThreadTitle) {
    state.focusThreadTitle = false;
    $("thread-title").focus({ preventScroll: true });
  }
}

// Reload the open thread when the list shows it changed (only while she can see it,
// because loading a thread marks its answer as read).
function syncOpenThread() {
  const open = state.openThread;
  if (!state.openId || !open || document.visibilityState !== "visible") return;
  const listed = state.threads.find((t) => t.id === state.openId);
  if (!listed || listed.status !== open.status || Number(listed.messageCount) !== open.messageCount) {
    loadThread(state.openId, { quiet: true });
  }
}

async function renderThread(thread, messages, seq) {
  let items;
  try {
    items = await Promise.all(messages.map(messageItem));
  } catch {
    items = messages.map((m) => el("li", { class: "msg msg-tutor" }, el("p", { class: "plain" }, m.text || "")));
  }
  if (seq !== state.threadSeq || state.openId !== thread.id) return false;

  const messageCount = typeof thread.messageCount === "number" ? thread.messageCount : messages.length;
  state.openThread = { ...thread, messageCount };
  renderThreadHead(thread);
  $("messages").replaceChildren(...items);
  clearFormError("thread-error");
  $("thread-retry").hidden = true;
  renderThreadStatus(thread);

  const closed = thread.status === "closed";
  $("resolve-row").hidden = closed;
  $("resolve-prompt").textContent = thread.status === "answered" ? "¿Ya te quedó claro?" : "¿Lo resolviste por tu cuenta?";
  $("closed-note").hidden = !closed;
  $("reply-title").textContent = closed
    ? "¿Quieres volver a preguntar algo?"
    : thread.status === "answered"
      ? "¿Tienes otra duda sobre esto?"
      : "¿Quieres añadir algo más?";
  $("reply-form").hidden = false;
  updateNotifyButtons();
  return true;
}

function renderThreadHead(t) {
  $("thread-num").textContent = `${t.kind === "direct" ? "Mensaje" : "Pregunta"} #${t.number}`;
  $("thread-title").textContent = t.title || "";
  $("thread-meta").replaceChildren(
    ...spaced(
      statusPill(t.status),
      t.kind === "direct"
        ? el("span", {}, `Mensaje directo a ${tutorName()}`)
        : el("span", { class: "tag" }, topicLabel(t.topic)),
      t.origin === "email" && el("span", {}, "Llegó por correo"),
    ),
  );
}

function renderThreadMissing() {
  state.openThread = null;
  $("thread-num").textContent = "";
  $("thread-title").textContent = "No encontramos esta conversación";
  $("thread-meta").replaceChildren();
  $("messages").replaceChildren();
  $("thread-status").replaceChildren();
  $("resolve-row").hidden = true;
  $("closed-note").hidden = true;
  $("reply-form").hidden = true;
  $("notify-btn-thread").hidden = true;
  $("thread-retry").hidden = true;
  showFormError("thread-error", "Puede que se haya borrado. Vuelve a «Mis preguntas» para ver las demás.");
}

async function messageItem(m) {
  const who = m.from === "student" ? "student" : m.from === "alon" ? "alon" : "tutor";
  const name = who === "student" ? "Tú" : who === "alon" ? tutorName() : "Tutor IA";
  const badge = who === "student" ? initial(state.info?.studentName) : who === "alon" ? initial(tutorName()) : "IA";

  const body = el("div", { class: "msg-body" });
  if (who === "student") {
    if (m.text) body.append(el("p", { class: "plain" }, m.text));
  } else {
    body.append(el("div", { class: "md" }, await renderMarkdown(m.text || "")));
  }
  if (m.code) {
    body.append(
      el("pre", { class: "codeblock", tabindex: "0", "aria-label": "Código o mensaje de error" }, el("code", {}, m.code)),
    );
  }

  return el("li", { class: `msg msg-${who}` },
    el("div", { class: "msg-head" },
      spaced(
        el("span", { class: `avatar avatar-${who}`, "aria-hidden": "true" }, badge),
        el("span", { class: "msg-author" }, name),
        timeEl(m.createdAt),
        m.via === "email" && el("span", {}, "por correo"),
      )),
    body);
}

// Live region under the messages: "writing…" while answering, a calm note while waiting.
function renderThreadStatus(thread) {
  const box = $("thread-status");
  const key = `${thread.status}:${thread.kind}`;
  if (box.dataset.key === key) return; // unchanged, don't announce it again
  box.dataset.key = key;
  box.classList.toggle("is-typing", thread.status === "answering");
  if (thread.status === "answering") {
    box.replaceChildren(
      el("span", { class: "dots", "aria-hidden": "true" }, el("span"), el("span"), el("span")),
      el("span", {}, "El tutor está escribiendo…"),
    );
  } else if (thread.status === "waiting") {
    const auto = thread.kind === "direct" ? state.info?.auto?.direct : state.info?.auto?.question;
    box.replaceChildren(
      el("span", {},
        auto
          ? "Recibido. El Tutor IA suele responder en más o menos un minuto. Puedes esperar aquí o volver más tarde."
          : `Recibido. ${tutorName()} lo leerá y te responderá cuando pueda. La respuesta aparecerá aquí.`),
    );
  } else {
    box.replaceChildren();
  }
}

async function submitReply(ev) {
  ev.preventDefault();
  if (state.replying || !state.openId) return;
  const id = state.openId;
  const textEl = $("r-text");
  const codeEl = $("r-code");
  const text = textEl.value.trim();
  const code = cleanCode(codeEl.value);

  let problem = null;
  if (!text) problem = [textEl, "Escribe tu mensaje antes de enviarlo."];
  else if (text.length > LIMITS.text) problem = [textEl, `El mensaje es muy largo: máximo ${LIMITS.text} caracteres (ahora tiene ${text.length}).`];
  else if (code.length > LIMITS.code) problem = [codeEl, `El código es muy largo: máximo ${LIMITS.code} caracteres. Pega solo la parte que falla.`];
  if (problem) {
    if (problem[0] === codeEl) $("r-code-box").open = true;
    return showFormError("reply-error", problem[1], problem[0]);
  }

  clearFormError("reply-error");
  const button = $("reply-submit");
  state.replying = true;
  button.disabled = true;
  button.textContent = "Enviando…";
  try {
    await call("send", { room: state.room, id, text, code });
    const form = $("reply-form");
    form.reset();
    for (const field of form.querySelectorAll("[aria-invalid]")) field.removeAttribute("aria-invalid");
    $("r-code-box").open = false;
    updateCounters();
    fireProcess(id);
    announce("Mensaje enviado.");
    if (state.openId === id) await loadThread(id, { quiet: true });
    state.poller?.refresh();
  } catch (err) {
    if (err?.code === "unauthorized") return signOut();
    showFormError("reply-error", errorMessage(err, { sending: true }));
  } finally {
    state.replying = false;
    button.disabled = false;
    button.textContent = "Enviar";
  }
}

async function resolveOpenThread() {
  const id = state.openId;
  if (!id) return;
  const button = $("resolve-btn");
  button.disabled = true;
  try {
    await call("resolve", { room: state.room, id });
    await loadThread(id, { quiet: true });
    toast("¡Muy bien! La marcamos como resuelta.");
    if (!$("closed-note").hidden) $("closed-note").focus();
    state.poller?.refresh();
  } catch (err) {
    if (err?.code === "unauthorized") return signOut();
    toast(errorMessage(err), { tone: "error", ms: 6000 });
  } finally {
    button.disabled = false;
  }
}

// ---------- wiring ----------

function bindEvents() {
  document.addEventListener("click", onRouteClick);
  window.addEventListener("popstate", () => route({ focus: true }));
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("visibilitychange", updateBadge);

  $("retry-btn").addEventListener("click", () => connect({ fromRetry: true }));

  const compose = $("compose-form");
  compose.addEventListener("submit", submitCompose);
  compose.addEventListener("input", onComposeInput);
  compose.addEventListener("change", onComposeChange);
  $("draft-clear").addEventListener("click", clearDraft);

  const reply = $("reply-form");
  reply.addEventListener("submit", submitReply);
  reply.addEventListener("input", (ev) => {
    if (ev.target.getAttribute?.("aria-invalid")) {
      ev.target.removeAttribute("aria-invalid");
      clearFormError("reply-error");
    }
    updateCounters();
  });

  $("resolve-btn").addEventListener("click", resolveOpenThread);
  $("thread-retry").addEventListener("click", () => {
    if (state.openId) loadThread(state.openId);
  });
  for (const button of document.querySelectorAll(".js-notify")) button.addEventListener("click", enableNotifications);
}

bindEvents();
updateCounters();
start();
