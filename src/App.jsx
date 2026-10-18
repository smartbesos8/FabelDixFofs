import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase.js";

/* ============================================================
   FABEL — a Dixit-style storytelling card game
   Transport: Supabase (Postgres + Realtime). Every action applies
   directly and atomically from the acting player's own device —
   there's no "host" driving a queue, so no single tab can stall
   the game for everyone else.
   ============================================================ */

const HAND_SIZE = 6;
const WIN_SCORE = 30;
const FALLBACK_POLL_MS = 5000; // belt-and-braces if a realtime event is ever missed
const PHASE_TIMER_S = 45; // soft, informational nudge only — never blocks a player
const SEAT_KEY = "fabel:seat";

const C = {
  night: "#0E1F26",
  night2: "#16323C",
  night3: "#1F454F",
  bone: "#F2EAE0",
  amber: "#F0B458",
  violet: "#B98CC4",
  muted: "#7C9BA3",
  green: "#7FD1C1",
};

/* ---------- identity: a real browser-local id, per profile/device ---------- */
function getDeviceId() {
  try {
    let id = localStorage.getItem("fabel:device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("fabel:device", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
function saveSeat(code, player) {
  try {
    localStorage.setItem(SEAT_KEY, JSON.stringify({ code, id: player.id, name: player.name }));
    localStorage.setItem("fabel:name", player.name); // pre-fills the name box next visit
  } catch {}
}
function loadSeat() {
  try {
    return JSON.parse(localStorage.getItem(SEAT_KEY) || "null");
  } catch {
    return null;
  }
}
function clearSeat() {
  try {
    localStorage.removeItem(SEAT_KEY);
  } catch {}
}

/* ---------- utils ---------- */
// Opens Google Translate (website, or the app if installed) with the clue
// filled in, auto-detecting its language and translating into the
// player's own phone/browser language. Free, no API key involved.
function myLang() {
  return (typeof navigator !== "undefined" && (navigator.language || "en").split("-")[0]) || "en";
}
function translateUrl(text) {
  return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(myLang())}&text=${encodeURIComponent(text)}&op=translate`;
}
// In-page translation, so nobody has to leave the game (and so it works on
// Android, where the Translate app hijacks translate.google.com links and
// drops the text). Uses Google's free keyless web endpoint — unofficial, so
// if it ever stops answering we fall back to the plain link above.
async function translateText(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(myLang())}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("translate " + res.status);
  const data = await res.json();
  const out = (data?.[0] || []).map((part) => part?.[0] || "").join("").trim();
  if (!out) throw new Error("empty translation");
  return { text: out, from: data?.[2] || "" };
}
function langName(code) {
  try {
    return new Intl.DisplayNames([myLang()], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = (arr, rnd = Math.random) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const code4 = () => {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join("");
};

/* ---------- procedural card art (placeholder deck) ---------- */
const SILHOUETTES = [
  "M50 78 L50 52 M50 60 L40 68 M50 60 L60 68 M50 52 a5 5 0 1 1 0.1 0",
  "M35 80 Q50 30 65 80 Z",
  "M40 80 L40 45 L60 45 L60 80 Z M46 60 a2 2 0 1 1 0.1 0",
  "M30 80 Q50 68 70 80 L66 72 Q50 62 34 72 Z M50 66 L50 40 L64 46 L50 52",
  "M32 80 L44 80 L44 68 L56 68 L56 56 L68 56 L68 44",
  "M50 46 a12 12 0 1 1 -0.1 0 M50 34 L50 24 M50 58 L50 72",
  "M38 74 Q50 40 62 74 M50 40 L50 30",
  "M28 62 q10 -12 20 0 q10 12 20 0 q10 -12 14 0",
  "M44 80 L44 40 a6 6 0 1 1 12 0 L56 80 M38 56 L62 56",
  "M50 30 L62 56 L50 82 L38 56 Z",
];

function CardArt({ seed, url }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (url && !broken) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        draggable={false}
        onError={() => setBroken(true)}
      />
    );
  }
  const r = mulberry32(seed * 7919 + 13);
  const hue = Math.floor(r() * 360);
  const hue2 = (hue + 40 + Math.floor(r() * 120)) % 360;
  const moonX = 20 + r() * 60;
  const moonY = 15 + r() * 25;
  const moonR = 6 + r() * 12;
  const sil = SILHOUETTES[Math.floor(r() * SILHOUETTES.length)];
  const stars = Array.from({ length: 14 }, () => [r() * 100, r() * 60, r() * 1.1 + 0.3]);
  const h1 = 62 + r() * 10;
  const h2 = 74 + r() * 10;
  const gid = `g${seed}`;
  return (
    <svg viewBox="0 0 100 140" style={{ width: "100%", height: "100%", display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue},55%,${18 + r() * 14}%)`} />
          <stop offset="55%" stopColor={`hsl(${hue2},48%,${34 + r() * 16}%)`} />
          <stop offset="100%" stopColor={`hsl(${(hue2 + 30) % 360},40%,${14 + r() * 10}%)`} />
        </linearGradient>
      </defs>
      <rect width="100" height="140" fill={`url(#${gid})`} />
      {stars.map(([x, y, s], i) => (
        <circle key={i} cx={x} cy={y} r={s} fill="#fff" opacity={0.5 + r() * 0.4} />
      ))}
      <circle cx={moonX} cy={moonY} r={moonR} fill="#fff" opacity="0.82" />
      <circle cx={moonX + moonR * 0.4} cy={moonY - moonR * 0.25} r={moonR * 0.9} fill={`hsl(${hue},55%,22%)`} opacity="0.55" />
      <path
        d={`M0 ${h1} Q 25 ${h1 - 14} 50 ${h1} T 100 ${h1} L100 140 L0 140 Z`}
        fill={`hsl(${hue2},40%,${18 + r() * 8}%)`}
        opacity="0.85"
      />
      <g transform={`translate(0 ${h2 - 78}) scale(1)`}>
        <path d={sil} fill="none" stroke={`hsl(${hue},20%,88%)`} strokeWidth="2.2" strokeLinecap="round" opacity="0.9" />
      </g>
      <path
        d={`M0 ${h2 + 6} Q 30 ${h2 - 4} 60 ${h2 + 8} T 100 ${h2 + 4} L100 140 L0 140 Z`}
        fill={`hsl(${(hue + 200) % 360},35%,12%)`}
      />
    </svg>
  );
}

function CardBack() {
  return (
    <svg viewBox="0 0 100 140" style={{ width: "100%", height: "100%", display: "block" }}>
      <rect width="100" height="140" fill={C.night2} />
      <circle cx="50" cy="70" r="26" fill="none" stroke={C.amber} strokeWidth="1.2" opacity="0.55" />
      <circle cx="50" cy="70" r="17" fill="none" stroke={C.violet} strokeWidth="1" opacity="0.5" />
      <circle cx="50" cy="70" r="6" fill={C.amber} opacity="0.75" />
      <path d="M20 70 Q50 46 80 70 Q50 94 20 70 Z" fill="none" stroke={C.bone} strokeWidth="1" opacity="0.35" />
    </svg>
  );
}

/* ---------- game logic (pure — same rules as before) ---------- */
function freshCore(code, host, deckUrls, deckSize = 84) {
  return {
    code,
    hostId: host.id,
    phase: "lobby",
    round: 0,
    players: [{ id: host.id, name: host.name, score: 0 }],
    deckUrls: deckUrls || [],
    deckSize,
    pile: [],
    discard: [],
    hands: {},
    storytellerIdx: 0,
    clue: "",
    clueAudioUrl: null,
    storytellerCard: null,
    submissions: [],
    votes: {},
    result: null,
    stamp: Date.now(),
  };
}

function deckCards(core) {
  const n = core.deckUrls.length ? core.deckUrls.length : core.deckSize;
  return Array.from({ length: n }, (_, i) => i);
}

function drawTo(core, playerId) {
  const hand = core.hands[playerId] || [];
  while (hand.length < HAND_SIZE) {
    if (!core.pile.length) {
      core.pile = shuffle(core.discard);
      core.discard = [];
      if (!core.pile.length) break;
    }
    hand.push(core.pile.pop());
  }
  core.hands[playerId] = hand;
}

function startGame(core) {
  core.pile = shuffle(deckCards(core));
  core.discard = [];
  core.hands = {};
  core.players.forEach((p) => {
    p.score = 0;
    drawTo(core, p.id);
  });
  core.round = 1;
  core.storytellerIdx = 0;
  core.phase = "clue";
  core.clue = "";
  core.clueAudioUrl = null;
  core.storytellerCard = null;
  core.submissions = [];
  core.votes = {};
  core.result = null;
}

function tally(core) {
  const st = core.players[core.storytellerIdx];
  const stCard = core.storytellerCard;
  const guessers = core.players.filter((p) => p.id !== st.id);
  const correct = guessers.filter((p) => core.votes[p.id] === stCard);
  const gains = {};
  core.players.forEach((p) => (gains[p.id] = 0));

  const allOrNone = correct.length === 0 || correct.length === guessers.length;
  if (allOrNone) {
    guessers.forEach((p) => (gains[p.id] += 2));
  } else {
    gains[st.id] += 3;
    correct.forEach((p) => (gains[p.id] += 3));
  }
  Object.entries(core.votes).forEach(([, card]) => {
    if (card === stCard) return;
    const owner = core.submissions.find((s) => s.card === card)?.playerId;
    if (owner && owner !== st.id) gains[owner] += 1;
  });

  core.players.forEach((p) => (p.score += gains[p.id]));
  core.result = { gains, stCard, correctIds: correct.map((p) => p.id), allOrNone };
  core.phase = "reveal";
}

function nextRound(core) {
  core.submissions.forEach((s) => core.discard.push(s.card));
  core.players.forEach((p) => drawTo(core, p.id));
  if (core.players.some((p) => p.score >= WIN_SCORE)) {
    core.phase = "end";
    return;
  }
  core.round += 1;
  core.storytellerIdx = (core.storytellerIdx + 1) % core.players.length;
  core.phase = "clue";
  core.clue = "";
  core.clueAudioUrl = null;
  core.storytellerCard = null;
  core.submissions = [];
  core.votes = {};
  core.result = null;
}

function clearRound(core) {
  core.clue = "";
  core.clueAudioUrl = null;
  core.storytellerCard = null;
  core.submissions = [];
  core.votes = {};
  core.result = null;
}

function resetToLobby(core) {
  core.submissions.forEach((s) => core.discard.push(s.card));
  core.phase = "lobby";
  core.round = 0;
  core.storytellerIdx = 0;
  clearRound(core);
}

/* Someone walks away — at any point. Keeps the room playable for whoever's
   left: hands the host role on, drops their card/vote from the current
   round, and finishes or restarts the round if they were what it was
   waiting on. Under 3 players, the table goes back to the lobby. */
function leaveRoom(core, pid) {
  const idx = core.players.findIndex((p) => p.id === pid);
  if (idx === -1) return;
  const wasSt = idx === core.storytellerIdx;
  core.players.splice(idx, 1);
  delete core.hands[pid];
  if (core.hostId === pid && core.players.length) core.hostId = core.players[0].id;
  if (idx < core.storytellerIdx) core.storytellerIdx -= 1;
  if (core.storytellerIdx >= core.players.length) core.storytellerIdx = 0;

  const inRound = ["clue", "submit", "vote", "reveal"].includes(core.phase);
  if (!inRound) return;
  if (core.players.length < 3) return resetToLobby(core);

  if (wasSt && core.phase !== "reveal") {
    // the teller left mid-round — scrap the round, next player tells
    core.submissions.forEach((s) => core.discard.push(s.card));
    core.players.forEach((p) => drawTo(core, p.id));
    core.round += 1;
    core.phase = "clue";
    clearRound(core);
    return;
  }

  const mine = core.submissions.find((s) => s.playerId === pid);
  if (mine && core.phase !== "reveal") {
    core.discard.push(mine.card);
    core.submissions = core.submissions.filter((s) => s.playerId !== pid);
    Object.keys(core.votes).forEach((v) => core.votes[v] === mine.card && delete core.votes[v]);
  }
  delete core.votes[pid];
  if (core.phase === "submit" && core.submissions.length === core.players.length) {
    core.submissions = shuffle(core.submissions);
    core.phase = "vote";
  } else if (core.phase === "vote" && Object.keys(core.votes).length === core.players.length - 1) {
    tally(core);
  }
}

/* Applies one player's action directly against the current state.
   No queue, no seq numbers — Postgres's own atomic UPDATE (below) is what
   keeps two simultaneous actions from clobbering each other, so this just
   needs to be correct for a single application. */
function applyAction(core, pid, act) {
  const st = core.players[core.storytellerIdx];

  if (act.type === "join") {
    if (core.phase !== "lobby") return false;
    const existing = core.players.find((p) => p.id === pid);
    if (existing) existing.name = act.name;
    else core.players.push({ id: pid, name: act.name, score: 0 });
    return true;
  }
  if (act.type === "leave") {
    leaveRoom(core, pid);
    return true;
  }
  if (act.type === "lobby") {
    // host sends everyone back to the lobby, so people can leave or new ones join
    if (pid !== core.hostId || core.phase !== "end") return false;
    resetToLobby(core);
    return true;
  }
  if (act.type === "start") {
    if (core.phase !== "lobby" || pid !== core.hostId) return false;
    const need = core.players.length * HAND_SIZE + 4;
    const size = core.deckUrls.length || core.deckSize;
    if (size < need) return false;
    startGame(core);
    return true;
  }
  if (act.round !== core.round || act.phase !== core.phase) return false;

  if (act.type === "clue" && pid === st.id) {
    if (!act.clue?.trim() && !act.clueAudioUrl) return false; // need a word or a voice clip
    core.clue = (act.clue || "").slice(0, 120);
    core.clueAudioUrl = act.clueAudioUrl || null;
    core.storytellerCard = act.card;
    core.hands[pid] = core.hands[pid].filter((c) => c !== act.card);
    core.submissions = [{ playerId: pid, card: act.card }];
    core.phase = "submit";
  } else if (act.type === "submit" && pid !== st.id) {
    if (core.submissions.some((s) => s.playerId === pid)) return false;
    core.submissions.push({ playerId: pid, card: act.card });
    core.hands[pid] = core.hands[pid].filter((c) => c !== act.card);
    if (core.submissions.length === core.players.length) {
      core.submissions = shuffle(core.submissions);
      core.phase = "vote";
    }
  } else if (act.type === "vote" && pid !== st.id) {
    if (core.votes[pid] !== undefined) return false;
    core.votes[pid] = act.card;
    if (Object.keys(core.votes).length === core.players.length - 1) tally(core);
  } else if (act.type === "next" && pid === core.hostId) {
    nextRound(core);
  } else if (act.type === "restart" && pid === core.hostId) {
    startGame(core);
  } else {
    return false;
  }
  return true;
}

/* ---------- Supabase row <-> app state mapping ---------- */
function rowToState(row) {
  return {
    code: row.code,
    hostId: row.host_id,
    phase: row.phase,
    round: row.round,
    players: row.players || [],
    deckUrls: row.deck_urls || [],
    deckSize: row.deck_size,
    pile: row.pile || [],
    discard: row.discard || [],
    hands: row.hands || {},
    storytellerIdx: row.storyteller_idx,
    clue: row.clue || "",
    clueAudioUrl: row.clue_audio_url || null,
    storytellerCard: row.storyteller_card,
    submissions: row.submissions || [],
    votes: row.votes || {},
    result: row.result,
    stamp: Number(row.stamp),
  };
}
function stateToRow(s) {
  return {
    code: s.code,
    host_id: s.hostId,
    phase: s.phase,
    round: s.round,
    players: s.players,
    deck_urls: s.deckUrls,
    deck_size: s.deckSize,
    pile: s.pile,
    discard: s.discard,
    hands: s.hands,
    storyteller_idx: s.storytellerIdx,
    clue: s.clue,
    clue_audio_url: s.clueAudioUrl,
    storyteller_card: s.storytellerCard,
    submissions: s.submissions,
    votes: s.votes,
    result: s.result,
    stamp: s.stamp,
  };
}

/* Fetch the room, apply a mutation, and write it back with an atomic
   compare-and-swap on `stamp` (Postgres's WHERE clause guarantees this —
   no separate lock or host needed). If someone else wrote in between,
   retry against the fresh state a few times before giving up. */
async function withRoom(code, mutate, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const { data: row, error } = await supabase.from("rooms").select("*").eq("code", code).single();
    if (error || !row) return { ok: false, reason: "not-found" };
    const state = rowToState(row);
    const changed = mutate(state);
    if (!changed) return { ok: false, reason: "rejected", state };
    state.stamp = Date.now();
    const { data: updated, error: upErr } = await supabase
      .from("rooms")
      .update(stateToRow(state))
      .eq("code", code)
      .eq("stamp", row.stamp)
      .select()
      .single();
    if (!upErr && updated) return { ok: true, state: rowToState(updated) };
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 220));
  }
  return { ok: false, reason: "conflict" };
}

/* ============================================================
   UI
   ============================================================ */

function useFonts() {
  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href =
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,600&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(l);
    return () => {
      try {
        document.head.removeChild(l);
      } catch {}
    };
  }, []);
}

/* Global keyframes + a few small resets — injected once, kept out of every
   inline style object. Respects prefers-reduced-motion throughout. */
function useGlobalStyles() {
  useEffect(() => {
    const s = document.createElement("style");
    s.textContent = `
      html, body, #root { max-width: 100%; overflow-x: hidden; }
      * { -webkit-tap-highlight-color: transparent; }
      input::placeholder, textarea::placeholder { color: ${C.muted}; font-weight: 400; font-style: italic; opacity: .75; letter-spacing: normal; }

      /* Card sizes. Laptop/desktop: grow with the window (capped by its
         height too, so a row still fits on a short laptop screen), rows wrap.
         Phones: either a sideways swipe of big cards, or — the "all cards"
         view — every card at once in a grid. */
      :root {
        --hand-w: clamp(132px, min(14.5vw, 26vh), 200px);
        --table-w: clamp(150px, min(19vw, 36vh), 260px);
      }
      .fabel-row { display: flex; gap: 12px; flex-wrap: wrap; padding-bottom: 10px; }
      .fabel-swipe-hint, .fabel-mobile-only { display: none; }
      /* big card in the viewer: as large as fits between the top bar and the
         pinned action button. svh = the *visible* height on phones (address
         bar included); the vh line is a fallback for older browsers. */
      .fabel-zoom-card { width: min(84vw, calc((100vh - 220px) * 5 / 7), 460px); }
      @supports (height: 100svh) { .fabel-zoom-card { width: min(84vw, calc((100svh - 190px) * 5 / 7), 460px); } }
      @media (max-width: 640px) {
        :root { --hand-w: 46vw; --table-w: 62vw; }
        .fabel-row {
          flex-wrap: nowrap; overflow-x: auto; scroll-snap-type: x mandatory;
          -webkit-overflow-scrolling: touch; padding: 8px 4px 14px; margin: 0 -4px;
          scrollbar-width: none;
        }
        .fabel-row::-webkit-scrollbar { display: none; }
        .fabel-row > * { scroll-snap-align: center; }
        .fabel-swipe-hint { display: block; }
        .fabel-mobile-only { display: inline-flex; }

        /* "All cards" view: hand in 3 columns (all 6 on screen), table in 2 */
        .fabel-layout-grid { --hand-w: calc((100vw - 32px - 16px) / 3); --table-w: calc((100vw - 32px - 8px) / 2); }
        .fabel-layout-grid .fabel-row {
          flex-wrap: wrap; overflow-x: visible; scroll-snap-type: none;
          gap: 8px; padding: 4px 0 10px; margin: 0;
        }
        .fabel-layout-grid .fabel-swipe-hint { display: none; }
      }
      @keyframes fabelFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .fabel-fade { animation: fabelFade .38s ease; }
      @keyframes fabelPulse { 0%, 100% { box-shadow: 0 0 0 0 ${C.violet}55; } 50% { box-shadow: 0 0 0 8px ${C.violet}00; } }
      .fabel-pulse { animation: fabelPulse 1.8s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .fabel-fade { animation: none !important; }
        .fabel-pulse { animation: none !important; }
        * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
      }
    `;
    document.head.appendChild(s);
    return () => {
      try {
        document.head.removeChild(s);
      } catch {}
    };
  }, []);
}

/* ---------- optional sound: a couple of soft synth chimes, no assets ---------- */
function useSound() {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem("fabel:sound") !== "off";
    } catch {
      return true;
    }
  });
  const ctxRef = useRef(null);

  const ensureCtx = useCallback(() => {
    if (!enabled) return null;
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctxRef.current = new AC();
      } catch {
        return null;
      }
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  }, [enabled]);

  const tone = useCallback(
    (freq, start, dur, gain = 0.045, type = "sine") => {
      const ctx = ensureCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = 0;
      osc.connect(g);
      g.connect(ctx.destination);
      const t0 = ctx.currentTime + start;
      g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    },
    [ensureCtx]
  );

  const chime = useCallback(() => {
    tone(880, 0, 0.5);
    tone(1318.5, 0.09, 0.55, 0.035);
  }, [tone]);

  const flourish = useCallback(() => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.1, 0.55, 0.04));
  }, [tone]);

  // a quiet tick for an ordinary chat message
  const blip = useCallback(() => tone(740, 0, 0.16, 0.035), [tone]);

  // hard-to-miss three-note call for a message flagged important
  const alert = useCallback(() => {
    [988, 784, 988].forEach((f, i) => tone(f, i * 0.18, 0.3, 0.08, "triangle"));
  }, [tone]);

  // Browsers only allow audio after the person has interacted with the page,
  // so unlock on their very first tap/keypress anywhere — otherwise someone
  // who's just watching would never hear chat or the reveal chime.
  useEffect(() => {
    const unlock = () => ensureCtx();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [ensureCtx]);

  const toggle = useCallback(() => {
    setEnabled((e) => {
      const next = !e;
      try {
        localStorage.setItem("fabel:sound", next ? "on" : "off");
      } catch {}
      return next;
    });
  }, []);

  // "your move" — a bright rising call, clearly different from chat sounds
  const yourTurn = useCallback(() => {
    [659.25, 880, 1174.66].forEach((f, i) => tone(f, i * 0.13, 0.42, 0.075, "triangle"));
  }, [tone]);

  return { enabled, toggle, chime, flourish, blip, alert, yourTurn, unlock: ensureCtx };
}

/* ---------- voice notes: record a short clip, upload it, get a URL ---------- */
async function uploadAudio(blob, path) {
  const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  const full = `${path}.${ext}`;
  const { error } = await supabase.storage.from("clue-audio").upload(full, blob, { contentType: blob.type });
  if (error) throw error;
  return supabase.storage.from("clue-audio").getPublicUrl(full).data.publicUrl;
}

/* Tap-to-start / tap-to-stop recorder, WhatsApp style. `onDone(blob)` fires
   when recording stops (or hits maxSecs); cancel() throws the clip away. */
function useRecorder(maxSecs, onDone, onError) {
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const recRef = useRef(null);
  const timerRef = useRef(null);
  const cancelledRef = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const stop = () => {
    clearInterval(timerRef.current);
    if (recRef.current?.state === "recording") recRef.current.stop();
  };
  const cancel = () => {
    cancelledRef.current = true;
    stop();
  };
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => window.MediaRecorder.isTypeSupported?.(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      cancelledRef.current = false;
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (!cancelledRef.current && chunks.length) doneRef.current(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
      setSecs(0);
      timerRef.current = setInterval(() => {
        setSecs((s) => {
          if (s + 1 >= maxSecs) stop();
          return s + 1;
        });
      }, 1000);
    } catch (e) {
      onError?.(e);
    }
  };
  useEffect(() => () => cancel(), []); // stop the mic if the panel unmounts mid-recording
  return { recording, secs, start, stop, cancel };
}

/* ---------- a light canvas confetti burst for the win screen ---------- */
function useConfetti(active) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const canvas = canvasRef.current;
    if (!canvas || reduce) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const colors = [C.amber, C.violet, C.green, C.bone];
    const parts = Array.from({ length: 130 }, () => ({
      x: Math.random() * window.innerWidth,
      y: -20 - Math.random() * window.innerHeight * 0.6,
      r: 3 + Math.random() * 4,
      c: colors[Math.floor(Math.random() * colors.length)],
      vy: 2 + Math.random() * 2.6,
      vx: -1.4 + Math.random() * 2.8,
      rot: Math.random() * Math.PI,
      vr: -0.22 + Math.random() * 0.44,
    }));
    let raf;
    const startTime = performance.now();
    const tick = (t) => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      parts.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r * 0.6, p.r * 2, p.r * 1.2);
        ctx.restore();
      });
      if (t - startTime < 2600) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [active]);
  return canvasRef;
}

const Btn = ({ children, onClick, disabled, tone = "amber", small }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      fontFamily: "Inter, system-ui, sans-serif",
      fontWeight: 600,
      fontSize: small ? 13 : 15,
      padding: small ? "8px 14px" : "12px 22px",
      minHeight: small ? 34 : 44,
      borderRadius: 999,
      border: "none",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.4 : 1,
      background: tone === "amber" ? C.amber : tone === "ghost" ? "transparent" : C.night3,
      color: tone === "amber" ? C.night : C.bone,
      boxShadow: tone === "ghost" ? `inset 0 0 0 1px ${C.muted}66` : "none",
      transition: "transform .12s ease, opacity .12s ease",
      touchAction: "manipulation",
    }}
    onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.97)")}
    onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
    onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
  >
    {children}
  </button>
);

const HAND_CARD_W = "var(--hand-w)";
const TABLE_CARD_W = "var(--table-w)";

/* `flip` makes the card mount face-down and turn face-up a beat later —
   used when cards land on the table so the reveal reads as a reveal. */
function Card({ seed, url, selected, dim, onClick, badge, width = HAND_CARD_W, flip, flipDelay = 0, onZoom }) {
  const [revealed, setRevealed] = useState(!flip);
  useEffect(() => {
    if (!flip) return;
    setRevealed(false);
    const t = setTimeout(() => setRevealed(true), 90 + flipDelay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip, flipDelay, seed]);

  const face = (hidden) => (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 10,
        overflow: "hidden",
        backfaceVisibility: flip ? "hidden" : undefined,
        transform: hidden ? "rotateY(180deg)" : "none",
        outline: !hidden && selected ? `3px solid ${C.amber}` : !hidden ? `1px solid ${C.muted}44` : "none",
        outlineOffset: !hidden && selected ? 2 : 0,
        opacity: !hidden && dim ? 0.42 : 1,
        background: C.night2,
      }}
    >
      {hidden ? (
        <CardBack />
      ) : (
        <>
          <CardArt seed={seed} url={url} />
          {badge && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                padding: "6px 8px",
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 600,
                color: C.bone,
                background: "linear-gradient(transparent, rgba(0,0,0,.85))",
              }}
            >
              {badge}
            </div>
          )}
          {onZoom && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onZoom();
              }}
              title="Look closer"
              aria-label="Enlarge card"
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: "none",
                background: "rgba(8,18,22,.72)",
                color: C.bone,
                fontSize: 16,
                lineHeight: "34px",
                padding: 0,
                cursor: "zoom-in",
                touchAction: "manipulation",
              }}
            >
              🔍
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => onClick && (e.key === "Enter" || e.key === " ") && onClick()}
      style={{
        position: "relative",
        width,
        aspectRatio: "5 / 7",
        cursor: onClick ? "pointer" : "default",
        flex: "0 0 auto",
        touchAction: "manipulation",
        perspective: flip ? 900 : undefined,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          transformStyle: flip ? "preserve-3d" : undefined,
          transition: flip ? "transform .55s cubic-bezier(.3,.15,.15,1)" : "transform .16s ease",
          transform: flip ? (revealed ? "rotateY(0deg)" : "rotateY(180deg)") : selected ? "translateY(-6px)" : "none",
        }}
      >
        {face(false)}
        {flip && face(true)}
      </div>
    </div>
  );
}

const linkBtnStyle = {
  marginLeft: 6,
  padding: "8px 6px",
  background: "none",
  border: "none",
  color: C.muted,
  fontSize: 12,
  cursor: "pointer",
  letterSpacing: 1,
  textDecoration: "underline",
  touchAction: "manipulation",
};

/* Lets the phone's Back button (or Escape) close an overlay instead of
   leaving the page: opening pushes a history entry, Back pops it. */
function useBackToClose(open, close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const pushed = useRef(false);
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ ditfofsOverlay: true }, "");
    pushed.current = true;
    const onPop = () => {
      pushed.current = false;
      closeRef.current();
    };
    const onKey = (e) => e.key === "Escape" && closeRef.current();
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      // closed some other way (✕ button) — drop the history entry we added
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
      }
    };
  }, [open]);
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(6,14,18,.82)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
  padding: 16,
};

const closeXStyle = {
  background: "none",
  border: "none",
  color: C.muted,
  fontSize: 26,
  cursor: "pointer",
  lineHeight: 1,
  padding: "4px 8px",
  touchAction: "manipulation",
};

/* Full-screen card viewer: swipe or arrows to flip through the row,
   optional "choose this card" action at the bottom. */
function Lightbox({ zoom, onClose }) {
  const [i, setI] = useState(zoom.index);
  const touchX = useRef(null);
  const n = zoom.items.length;
  const go = (d) => setI((x) => (x + d + n) % n);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  const item = zoom.items[i];
  const canPick = zoom.onPick && (!zoom.canPick || zoom.canPick(item));
  const arrow = {
    ...closeXStyle,
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 1,
    width: 44,
    height: 64,
    padding: 0,
    fontSize: 34,
    color: C.bone,
    background: "rgba(6,14,18,.55)",
    borderRadius: 10,
  };

  return (
    <div
      onClick={onClose}
      style={{
        ...overlayStyle,
        flexDirection: "column",
        justifyContent: "flex-start",
        padding: "max(8px, env(safe-area-inset-top)) 8px 0",
        gap: 8,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 560, display: "flex", alignItems: "center", justifyContent: "space-between", color: C.muted, fontSize: 13 }}
      >
        <span style={{ paddingLeft: 8 }}>
          {n > 1 && `${i + 1} / ${n}`}
          {item.label && <span style={{ color: C.bone, marginLeft: 10 }}>{item.label}</span>}
        </span>
        <button onClick={onClose} aria-label="Close" style={{ ...closeXStyle, color: C.bone, fontSize: 30 }}>
          ✕
        </button>
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}
        style={{ position: "relative" }}
      >
        {n > 1 && (
          <button onClick={() => go(-1)} aria-label="Previous card" style={{ ...arrow, left: 4 }}>
            ‹
          </button>
        )}
        <div
          className="fabel-zoom-card"
          style={{
            aspectRatio: "5 / 7",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 20px 60px rgba(0,0,0,.6)",
            background: C.night2,
          }}
        >
          <CardArt seed={item.seed} url={item.url} />
        </div>
        {n > 1 && (
          <button onClick={() => go(1)} aria-label="Next card" style={{ ...arrow, right: 4 }}>
            ›
          </button>
        )}
      </div>
      {/* Action bar pinned to the bottom of the screen, so it's always
          reachable even when the phone's address bar eats into the height. */}
      {zoom.onPick && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "12px 16px max(14px, env(safe-area-inset-bottom))",
            background: "linear-gradient(transparent, rgba(6,14,18,.96) 30%)",
            display: "flex",
            justifyContent: "center",
          }}
        >
          {canPick ? (
            <Btn
              onClick={() => {
                zoom.onPick(item);
                onClose();
              }}
            >
              {zoom.pickLabel || "Choose this card"}
            </Btn>
          ) : (
            <span style={{ color: C.muted, fontSize: 13, padding: "12px 0" }}>{zoom.cantPickNote || "You can't pick this one"}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* Step-by-step "my microphone won't work" guide, most likely platform first. */
function MicHelp({ onClose, display, reason }) {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const inApp = /WhatsApp|FBAN|FBAV|Instagram|Line\//i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const android = /Android/i.test(ua);
  const sections = [
    {
      key: "inapp",
      show: true,
      title: "Opened from WhatsApp? Open it in your real browser first",
      steps: [
        "Links tapped inside WhatsApp open in WhatsApp's own mini-browser, which often blocks the microphone.",
        ios ? "Tap the share/compass icon at the bottom and choose “Open in Safari”." : "Tap ⋮ (top right) and choose “Open in Chrome” / “Open in browser”.",
        "Then rejoin the room — you'll keep your seat.",
      ],
    },
    {
      key: "ios",
      show: true,
      title: "iPhone / iPad (Safari)",
      steps: [
        "Tap “aA” (or the ⋯ icon) in the address bar → Website Settings → Microphone → Allow.",
        "Still blocked? iPhone Settings → Apps → Safari → Microphone → Ask or Allow.",
        "Reload the page and try 🎤 again — say Allow when it asks.",
      ],
    },
    {
      key: "android",
      show: true,
      title: "Android (Chrome)",
      steps: [
        "Tap the icon left of the web address (🔒 or ⚙︎) → Permissions → Microphone → Allow.",
        "Still blocked? Phone Settings → Apps → Chrome → Permissions → Microphone → Allow only while using the app.",
        "Reload the page and try 🎤 again.",
      ],
    },
    {
      key: "desktop",
      show: true,
      title: "Laptop / desktop (Chrome, Edge, Firefox)",
      steps: [
        "Click the icon left of the web address → Microphone → Allow, then reload.",
        "Windows: Settings → Privacy & security → Microphone → turn on access for your browser.",
        "Mac: System Settings → Privacy & Security → Microphone → tick your browser.",
        "Make sure a microphone is plugged in / not muted, and no other app is using it.",
      ],
    },
  ];
  const first = inApp ? "inapp" : ios ? "ios" : android ? "android" : "desktop";
  const ordered = [...sections.filter((s) => s.key === first), ...sections.filter((s) => s.key !== first)];

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 480,
          width: "100%",
          maxHeight: "86vh",
          overflowY: "auto",
          background: C.night2,
          borderRadius: 16,
          padding: "22px 22px 18px",
          boxShadow: "0 20px 60px rgba(0,0,0,.5)",
          color: C.bone,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ ...display, fontSize: 22 }}>🎤 Getting the microphone working</span>
          <button onClick={onClose} aria-label="Close" style={closeXStyle}>
            ✕
          </button>
        </div>
        {reason && <p style={{ color: C.amber, fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>{reason}</p>}
        <p style={{ fontSize: 13, color: C.muted, marginTop: 10, lineHeight: 1.6 }}>
          A voice clue is optional — you can always just type your clue instead. To record, your browser has to
          be allowed to use the microphone for this site:
        </p>
        {ordered.map((s, k) => (
          <div key={s.key} style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: k === 0 ? C.amber : C.bone }}>
              {k === 0 && "→ "}
              {s.title}
            </div>
            <ol style={{ paddingLeft: 20, margin: "6px 0 0", fontSize: 13, lineHeight: 1.6, color: C.bone }}>
              {s.steps.map((t, j) => (
                <li key={j}>{t}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

/* "Put DitFofs on your home screen" — one-tap install on Android/desktop
   Chrome when the browser offers it, step-by-step instructions otherwise. */
function InstallHelp({ onClose, display, installPrompt, onInstall }) {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const inApp = /WhatsApp|FBAN|FBAV|Instagram/i.test(ua);
  const steps = inApp
    ? [
        "You're inside WhatsApp's mini-browser — first open this page in your normal browser:",
        ios ? "tap the share/compass icon → “Open in Safari”." : "tap ⋮ → “Open in Chrome”.",
        "Then come back to this button.",
      ]
    : ios
    ? [
        "Tap the Share button (the square with an arrow ↑) at the bottom of Safari.",
        "Scroll down and tap “Add to Home Screen”.",
        "Tap “Add”. DitFofs now has its own icon and opens full-screen.",
      ]
    : [
        "Tap ⋮ (top right in Chrome).",
        "Tap “Add to Home screen” or “Install app”.",
        "Confirm. DitFofs now has its own icon and opens full-screen.",
      ];

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 440, width: "100%", background: C.night2, borderRadius: 16, padding: "22px", color: C.bone }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ ...display, fontSize: 22 }}>📲 Add to your home screen</span>
          <button onClick={onClose} aria-label="Close" style={closeXStyle}>
            ✕
          </button>
        </div>
        {installPrompt && (
          <div style={{ marginTop: 16 }}>
            <Btn onClick={onInstall}>Install DitFofs</Btn>
          </div>
        )}
        <ol style={{ paddingLeft: 20, marginTop: 16, fontSize: 14, lineHeight: 1.7 }}>
          {steps.map((t, j) => (
            <li key={j}>{t}</li>
          ))}
        </ol>
        <p style={{ fontSize: 12, color: C.muted, marginTop: 12, lineHeight: 1.6 }}>
          No app store, nothing to pay — it's just a shortcut to this page with its own icon. Share the same link with
          others and they can do the same. (On iPhone the home-screen version keeps its own memory, so you may need to
          type your name once more the first time.)
        </p>
      </div>
    </div>
  );
}

function Header({ code, display, round, onLeave, onHelp, soundOn, onToggleSound }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <span style={{ ...display, fontSize: 24 }}>DitFofs</span>
      <span style={{ fontSize: 12, color: C.muted, letterSpacing: 2, display: "inline-flex", alignItems: "baseline" }}>
        {round ? `ROUND ${round} · ` : ""}
        {code}
        {onToggleSound && (
          <button
            onClick={onToggleSound}
            title={soundOn ? "Mute sound" : "Unmute sound"}
            style={{ ...linkBtnStyle, textDecoration: "none", fontSize: 14 }}
          >
            {soundOn ? "🔊" : "🔇"}
          </button>
        )}
        {onHelp && (
          <button onClick={onHelp} style={linkBtnStyle}>
            RULES
          </button>
        )}
        {onLeave && (
          <button onClick={onLeave} style={linkBtnStyle}>
            LEAVE
          </button>
        )}
      </span>
    </div>
  );
}

function HelpPanel({ onClose, display }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(6,14,18,.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 440,
          width: "100%",
          background: C.night2,
          borderRadius: 16,
          padding: "26px 24px",
          boxShadow: "0 20px 60px rgba(0,0,0,.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...display, fontSize: 22 }}>How to play</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: C.muted, fontSize: 22, cursor: "pointer", lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <ol style={{ paddingLeft: 18, marginTop: 16, fontSize: 14, lineHeight: 1.7, color: C.bone }}>
          <li>The <b>storyteller</b> picks a card and gives a one-line clue — a word, a phrase, a sound.</li>
          <li>Everyone else secretly picks a card from their own hand that could also fit that clue.</li>
          <li>All chosen cards are shuffled and shown. Everyone but the storyteller votes for the one they think was the storyteller's.</li>
          <li>
            Guess right and you both score — but if <i>everyone</i> guesses right, or <i>no one</i> does, only
            the guessers score. Fool someone with your own card and you pick up a point too.
          </li>
        </ol>
        <p style={{ fontSize: 12, color: C.muted, marginTop: 16, lineHeight: 1.6 }}>
          Updates arrive live — no need to tap twice. The ⏱ next to "still choosing" is a soft nudge, not a
          countdown that locks anyone out.
        </p>
        <ul style={{ paddingLeft: 18, marginTop: 12, fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
          <li>🔍 on a card opens it big — swipe or use the arrows to look through the rest.</li>
          <li>🎤 As the teller you can record your clue instead of typing it. Tap “mic not working?” if your browser blocks it.</li>
          <li>💬 Chat with the table any time; tap ❗ before sending to make it ring loudly for everyone. With the text box empty, 🎤 records a voice message (tap ➤ to send, ✕ to throw it away).</li>
          <li>🔔 When it's your move (the teller has spoken, voting starts, or it's your turn to tell) you'll hear a call and see a banner.</li>
          <li>LEAVE (top right) always lets you out — the game carries on for the others.</li>
        </ul>
      </div>
    </div>
  );
}

/* Floating table chat — ephemeral (nothing persisted), relayed live over
   Supabase Realtime broadcast. A round badge on the toggle shows unread
   count while closed. */
function ChatPanel({
  open,
  onToggle,
  msgs,
  myDeviceId,
  chatIn,
  setChatIn,
  onSend,
  unread,
  important,
  setImportant,
  onSendVoice,
  onMicError,
  voiceBusy,
}) {
  const listRef = useRef(null);
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, msgs.length]);
  const canRecordVoice = typeof window !== "undefined" && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia;
  const rec = useRecorder(30, onSendVoice, onMicError);
  useEffect(() => {
    if (!open && rec.recording) rec.cancel(); // closing the chat throws away an unfinished voice note
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const roundBtn = (extra) => ({
    flex: "0 0 auto",
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "none",
    fontSize: 17,
    cursor: "pointer",
    touchAction: "manipulation",
    ...extra,
  });

  return (
    <div
      style={{
        position: "fixed",
        right: "max(16px, env(safe-area-inset-right))",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        zIndex: 45,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
      }}
    >
      {open && (
        <div
          style={{
            width: "min(88vw, 300px)",
            height: 360,
            marginBottom: 10,
            background: C.night2,
            borderRadius: 14,
            boxShadow: "0 20px 60px rgba(0,0,0,.5)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "4px 6px 4px 14px",
              fontSize: 11,
              letterSpacing: 2,
              color: C.muted,
              borderBottom: `1px solid ${C.muted}22`,
            }}
          >
            TABLE CHAT
            <button onClick={onToggle} aria-label="Close chat" style={{ ...closeXStyle, fontSize: 22 }}>
              ✕
            </button>
          </div>
          <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            {msgs.length === 0 && <p style={{ color: C.muted, fontSize: 13 }}>Say something…</p>}
            {msgs.map((m) => (
              <div
                key={m.id}
                style={{
                  fontSize: 13,
                  lineHeight: 1.4,
                  wordBreak: "break-word",
                  ...(m.important
                    ? { background: "#e0554f26", boxShadow: "inset 3px 0 0 #e0554f", borderRadius: 6, padding: "6px 8px" }
                    : {}),
                }}
              >
                {m.important && <span style={{ color: "#ff8a84", fontWeight: 700 }}>❗ </span>}
                <b style={{ color: m.deviceId === myDeviceId ? C.amber : C.violet }}>{m.name}</b>{" "}
                {m.audioUrl ? (
                  <audio controls preload="metadata" src={m.audioUrl} style={{ display: "block", width: "100%", height: 34, marginTop: 4 }} />
                ) : (
                  <span style={{ color: C.bone }}>{m.text}</span>
                )}
              </div>
            ))}
          </div>
          {rec.recording || voiceBusy ? (
            <div style={{ display: "flex", gap: 8, padding: 10, borderTop: `1px solid ${C.muted}22`, alignItems: "center" }}>
              {voiceBusy ? (
                <span style={{ flex: 1, fontSize: 13, color: C.muted }}>Sending voice message…</span>
              ) : (
                <>
                  <button onClick={rec.cancel} aria-label="Cancel voice message" title="Throw away" style={roundBtn({ background: "transparent", color: C.muted, boxShadow: `inset 0 0 0 1px ${C.muted}55` })}>
                    ✕
                  </button>
                  <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.bone }}>
                    <span className="fabel-pulse" style={{ width: 10, height: 10, borderRadius: "50%", background: "#e0554f", display: "inline-block" }} />
                    Recording… 0:{String(rec.secs).padStart(2, "0")} / 0:30
                  </span>
                  <button onClick={rec.stop} aria-label="Send voice message" title="Send" style={roundBtn({ background: C.amber, color: C.night })}>
                    ➤
                  </button>
                </>
              )}
            </div>
          ) : (
          <div style={{ display: "flex", gap: 6, padding: 10, borderTop: `1px solid ${C.muted}22`, alignItems: "center" }}>
            <button
              onClick={() => setImportant(!important)}
              title={important ? "Marked important — everyone gets an alert sound" : "Mark as important (plays an alert for everyone)"}
              aria-pressed={important}
              style={{
                flex: "0 0 auto",
                width: 36,
                height: 36,
                borderRadius: 8,
                border: `1px solid ${important ? "#e0554f" : C.muted + "44"}`,
                background: important ? "#e0554f33" : "transparent",
                color: important ? "#ff8a84" : C.muted,
                fontSize: 16,
                fontWeight: 700,
                cursor: "pointer",
                touchAction: "manipulation",
              }}
            >
              ❗
            </button>
            <input
              value={chatIn}
              onChange={(e) => setChatIn(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSend()}
              placeholder={important ? "Important message…" : "Say something…"}
              style={{ ...inp, marginTop: 0, padding: "8px 10px" }}
            />
            {chatIn.trim() || !canRecordVoice ? (
              <Btn small disabled={!chatIn.trim()} onClick={onSend}>
                Send
              </Btn>
            ) : (
              <button
                onClick={rec.start}
                aria-label="Record a voice message"
                title="Record a voice message (tap, talk, tap ➤ to send)"
                style={roundBtn({ background: C.night3, color: C.bone })}
              >
                🎤
              </button>
            )}
          </div>
          )}
        </div>
      )}
      <button
        onClick={onToggle}
        title={open ? "Close chat" : "Table chat"}
        aria-label={open ? "Close chat" : "Open table chat"}
        style={{
          position: "relative",
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: "none",
          background: open ? C.night3 : C.amber,
          color: open ? C.bone : C.night,
          fontSize: open ? 20 : 22,
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(0,0,0,.4)",
          touchAction: "manipulation",
        }}
      >
        {open ? "✕" : "💬"}
        {!open && unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              background: "#e0554f",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}

/* Phone-only card view preference ("swipe" | "grid"), shared by every row. */
const LayoutContext = React.createContext({ layout: "swipe", setLayout: () => {} });

function LayoutToggle() {
  const { layout, setLayout } = React.useContext(LayoutContext);
  const seg = (value, text) => (
    <button
      onClick={() => setLayout(value)}
      aria-pressed={layout === value}
      style={{
        border: "none",
        padding: "6px 10px",
        fontSize: 12,
        fontFamily: "Inter, system-ui, sans-serif",
        cursor: "pointer",
        background: layout === value ? C.amber : "transparent",
        color: layout === value ? C.night : C.muted,
        fontWeight: layout === value ? 600 : 400,
        touchAction: "manipulation",
      }}
    >
      {text}
    </button>
  );
  return (
    <span
      className="fabel-mobile-only"
      style={{ borderRadius: 999, overflow: "hidden", boxShadow: `inset 0 0 0 1px ${C.muted}55`, flex: "0 0 auto" }}
    >
      {seg("swipe", "⇆ Swipe")}
      {seg("grid", "▦ All cards")}
    </span>
  );
}

function Row({ label, children }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, minHeight: 20 }}>
        <span style={{ fontSize: 11, letterSpacing: 2, color: C.muted }}>{label ? label.toUpperCase() : ""}</span>
        <LayoutToggle />
      </div>
      <div className="fabel-row">{children}</div>
      <div className="fabel-swipe-hint" style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
        ← swipe to see all cards · tap 🔍 to look closer →
      </div>
    </div>
  );
}

function Waiting({ names, verb, secsLeft }) {
  if (!names.length) return null;
  return (
    <p style={{ color: C.muted, fontSize: 13, marginTop: 18 }}>
      {names.join(", ")} {verb}
      {typeof secsLeft === "number" ? (
        <span style={{ marginLeft: 8, opacity: 0.8 }}>
          {secsLeft > 0 ? `⏱ ${secsLeft}s` : "· taking their time…"}
        </span>
      ) : (
        "…"
      )}
    </p>
  );
}

const inp = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  padding: "12px 14px",
  borderRadius: 10,
  border: `1px solid ${C.muted}44`,
  background: "#0B1A20",
  color: C.bone,
  fontSize: 16, // 16px keeps iOS Safari from auto-zooming in on focus
  fontFamily: "Inter, system-ui, sans-serif",
  outline: "none",
};

export default function App() {
  useFonts();
  useGlobalStyles();
  const sound = useSound();
  const deviceId = useRef(getDeviceId()).current;
  const [me, setMe] = useState(null);
  const [code, setCode] = useState("");
  const [core, setCore] = useState(null);
  const [screen, setScreen] = useState("home");
  const [nameIn, setNameIn] = useState(() => {
    try {
      return localStorage.getItem("fabel:name") || "";
    } catch {
      return "";
    }
  });
  const [codeIn, setCodeIn] = useState("");
  const [clueIn, setClueIn] = useState("");
  const [sel, setSel] = useState(null);
  const [deckIn, setDeckIn] = useState(() => {
    try {
      return localStorage.getItem("fabel:deck") || "";
    } catch {
      return "";
    }
  });
  const [deckCount, setDeckCount] = useState(() => {
    try {
      return Number(localStorage.getItem("fabel:deckCount")) || 89;
    } catch {
      return 84;
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const phaseStartRef = useRef(Date.now());
  const codeRef = useRef("");
  codeRef.current = code;
  const confettiRef = useConfetti(core?.phase === "end");
  const prevPhaseRef = useRef(null);

  /* ---- table chat: ephemeral, relayed live over the same room channel ---- */
  const channelRef = useRef(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatIn, setChatIn] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [chatImportant, setChatImportant] = useState(false);
  const [chatToast, setChatToast] = useState(null);
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;
  const soundRef = useRef(sound);
  soundRef.current = sound; // the realtime handler below outlives renders — read sound through a ref

  /* ---- overlays: card viewer, mic help, home-screen install help ---- */
  const [zoom, setZoom] = useState(null); // { items, index, onPick?, canPick?, pickLabel? }
  const [micHelp, setMicHelp] = useState(null); // null | "" | reason text
  const [showInstall, setShowInstall] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  useBackToClose(chatOpen, () => setChatOpen(false));
  useBackToClose(!!zoom, () => setZoom(null));
  useBackToClose(showHelp, () => setShowHelp(false));
  useBackToClose(micHelp !== null, () => setMicHelp(null));
  useBackToClose(showInstall, () => setShowInstall(false));

  // Android/desktop Chrome offer a one-tap "install" — keep the event for our button
  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);
  const install = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    setInstallPrompt(null);
    setShowInstall(false);
  };

  useEffect(() => {
    if (!chatToast) return;
    const t = setTimeout(() => setChatToast(null), 7000);
    return () => clearTimeout(t);
  }, [chatToast]);

  /* ---- voice clue: record → upload → replayable for everyone ---- */
  const canRecord = typeof window !== "undefined" && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia;
  const MAX_REC_S = 12;
  const [recState, setRecState] = useState("idle"); // idle | recording | recorded | uploading
  const [recBlob, setRecBlob] = useState(null);
  const [recUrl, setRecUrl] = useState(null);
  const [recSecs, setRecSecs] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recChunksRef = useRef([]);
  const recTimerRef = useRef(null);
  const clueInputRef = useRef(null);
  const [clueTr, setClueTr] = useState(null); // { for: clueText, text?, from?, loading?, failed? }
  const [cardLayout, setCardLayoutState] = useState(() => {
    try {
      return localStorage.getItem("fabel:cardLayout") === "grid" ? "grid" : "swipe";
    } catch {
      return "swipe";
    }
  });
  const setCardLayout = (v) => {
    setCardLayoutState(v);
    try {
      localStorage.setItem("fabel:cardLayout", v);
    } catch {}
  };

  /* ---- sounds on phase changes, plus a "your turn" alert whenever the
     game is now waiting on *you* (so nobody misses that the teller has
     spoken). Keyed on phase+round so it never fires on first load. ---- */
  const [turnAlert, setTurnAlert] = useState(null); // { key, title, body }
  const showTurnRef = useRef(false); // is the alert still relevant (move not made yet)? set during render below
  useEffect(() => {
    const phase = core?.phase;
    const key = phase ? `${phase}-${core.round}` : null;
    const prev = prevPhaseRef.current;
    if (key && prev && key !== prev) {
      if (phase === "reveal") sound.chime();
      if (phase === "end") sound.flourish();

      const teller = core.players[core.storytellerIdx];
      const amIn = me && core.players.some((p) => p.id === me.id);
      const iTell = amIn && teller?.id === me.id;
      let alert = null;
      if (amIn && phase === "clue" && iTell) alert = { title: "Your turn to tell!", body: "Pick a card and give a clue." };
      if (amIn && phase === "submit" && !iTell)
        alert = {
          title: `${teller?.name || "The teller"} has told a clue`,
          body: core.clue ? `“${core.clue}” — now pick a card from your hand that fits.` : "🎤 It's a voice clue — listen, then pick a card that fits.",
        };
      if (amIn && phase === "vote" && !iTell) alert = { title: "Time to vote!", body: "All cards are on the table — which one is the teller's?" };
      if (alert) {
        setTurnAlert({ key, ...alert });
        sound.yourTurn();
        try {
          navigator.vibrate?.([120, 60, 120]);
        } catch {}
      } else setTurnAlert(null);
    }
    prevPhaseRef.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core?.phase, core?.round]);

  // If you're in another tab/window, flash the tab title until you come back
  useEffect(() => {
    if (!turnAlert) return;
    const base = "DitFofs";
    let on = false;
    const tick = setInterval(() => {
      if (!showTurnRef.current || (!document.hidden && document.hasFocus())) {
        document.title = base;
        return;
      }
      on = !on;
      document.title = on ? "🔔 Your turn! · DitFofs" : base;
    }, 1000);
    return () => {
      clearInterval(tick);
      document.title = base;
    };
  }, [turnAlert]);

  useEffect(() => {
    phaseStartRef.current = Date.now();
  }, [core?.phase, core?.round]);
  useEffect(() => {
    const h = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const secsLeft = Math.max(0, PHASE_TIMER_S - Math.floor((nowTick - phaseStartRef.current) / 1000));

  useEffect(() => {
    setSel(null);
    setErr("");
    setZoom(null);
    discardRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core?.phase, core?.round]);

  /* ---- rejoin on load ---- */
  useEffect(() => {
    (async () => {
      const seat = loadSeat();
      if (seat?.code && seat?.id) {
        const { data } = await supabase.from("rooms").select("*").eq("code", seat.code).single();
        if (data) {
          const state = rowToState(data);
          if (state.players.some((p) => p.id === seat.id)) {
            setMe({ id: seat.id, name: seat.name });
            setCode(seat.code);
            setCore(state);
            setScreen("room");
          }
        }
      }
      setRestoring(false);
    })();
  }, []);

  /* ---- realtime subscription + light fallback poll ---- */
  useEffect(() => {
    if (!code) return;
    setChatMsgs([]);
    const channel = supabase
      .channel(`room-${code}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `code=eq.${code}` },
        (payload) => {
          if (payload.new) setCore(rowToState(payload.new));
        }
      )
      // Ephemeral table chat — nothing persisted, just relayed live to
      // whoever's currently connected. Own messages are echoed locally
      // below rather than round-tripped, so sending feels instant.
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        setChatMsgs((m) => [...m.slice(-49), payload]);
        if (payload.deviceId === deviceId) return;
        if (!chatOpenRef.current) setChatUnread((n) => n + 1);
        if (payload.important) {
          soundRef.current.alert();
          try {
            navigator.vibrate?.([180, 80, 180]);
          } catch {}
          setChatToast(payload);
        } else {
          soundRef.current.blip();
        }
      })
      .subscribe();
    channelRef.current = channel;

    const poll = setInterval(async () => {
      const { data } = await supabase.from("rooms").select("*").eq("code", code).single();
      if (data) setCore(rowToState(data));
    }, FALLBACK_POLL_MS);

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      clearInterval(poll);
    };
  }, [code]);

  // Always lets you out, whatever the phase. The room repairs itself for
  // whoever stays (see leaveRoom) and your saved seat is forgotten, so
  // opening the link again lands on the home screen, not back in the room.
  const leave = async () => {
    const midGame = core && !["lobby", "end"].includes(core.phase);
    if (midGame && !window.confirm("Leave this game? The others can keep playing without you.")) return;
    if (me && code) {
      await withRoom(code, (s) => applyAction(s, me.id, { type: "leave" }));
    }
    clearSeat();
    setMe(null);
    setCode("");
    setCore(null);
    setChatOpen(false);
    setChatUnread(0);
    setScreen("home");
  };

  const sendChat = () => {
    const text = chatIn.trim().slice(0, 200);
    if (!text || !channelRef.current || !me) return;
    sound.unlock();
    const payload = { id: crypto.randomUUID(), deviceId, name: me.name, text, important: chatImportant, t: Date.now() };
    channelRef.current.send({ type: "broadcast", event: "chat", payload });
    setChatMsgs((m) => [...m.slice(-49), payload]); // own message, echoed locally
    setChatIn("");
    setChatImportant(false);
  };

  const [voiceBusy, setVoiceBusy] = useState(false);
  const sendVoice = async (blob) => {
    if (!channelRef.current || !me) return;
    setVoiceBusy(true);
    try {
      const audioUrl = await uploadAudio(blob, `chat/${code}/${crypto.randomUUID()}`);
      const payload = { id: crypto.randomUUID(), deviceId, name: me.name, audioUrl, important: chatImportant, t: Date.now() };
      channelRef.current.send({ type: "broadcast", event: "chat", payload });
      setChatMsgs((m) => [...m.slice(-49), payload]);
      setChatImportant(false);
    } catch {
      setChatMsgs((m) => [
        ...m.slice(-49),
        { id: crypto.randomUUID(), deviceId: "system", name: "DitFofs", text: "That voice message didn't send — check your connection and try again." },
      ]);
    }
    setVoiceBusy(false);
  };
  const onChatMicError = (e) => {
    const name = e?.name || "";
    setMicHelp(
      name === "NotAllowedError" || name === "SecurityError"
        ? "Your browser blocked the microphone for this site. Here's how to allow it:"
        : name === "NotFoundError"
        ? "No microphone was found on this device."
        : name === "NotReadableError"
        ? "The microphone is busy — another app may be using it."
        : "The microphone couldn't be started. Here's what usually fixes it:"
    );
  };

  const toggleChat = () => {
    setChatOpen((o) => {
      if (!o) setChatUnread(0);
      return !o;
    });
  };

  /* ---- lobby actions ---- */
  const createRoom = async () => {
    if (!nameIn.trim()) return setErr("Enter a name first.");
    setBusy(true);
    setErr("");
    const player = { id: deviceId, name: nameIn.trim().slice(0, 16) };
    const urls = deckIn
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//.test(s));

    for (let i = 0; i < 4; i++) {
      const c = code4();
      const state = freshCore(c, player, urls, deckCount);
      const { data, error } = await supabase.from("rooms").insert(stateToRow(state)).select().single();
      if (!error && data) {
        saveSeat(c, player);
        try {
          if (urls.length) localStorage.setItem("fabel:deck", deckIn);
          else localStorage.removeItem("fabel:deck");
          localStorage.setItem("fabel:deckCount", String(deckCount));
        } catch {}
        setMe(player);
        setCode(c);
        setCore(rowToState(data));
        setScreen("room");
        setBusy(false);
        return;
      }
      if (error && error.code !== "23505") break; // anything but "code already taken" — stop retrying
    }
    setBusy(false);
    setErr("Couldn't create a room — check your connection and Supabase setup.");
  };

  /* Fills the deck box with card-01.jpg … card-NN.jpg, resolved relative to
     wherever this page is actually hosted — works the same on localhost and
     on a GitHub Pages subpath, no need to type your own repo URL. Normalizes
     to a trailing-slash directory first so it can't resolve one level too
     high if the page happened to load without one. */
  const autofillDeck = (count = deckCount) => {
    const here = new URL(window.location.href);
    if (!here.pathname.endsWith("/")) {
      here.pathname = here.pathname.slice(0, here.pathname.lastIndexOf("/") + 1);
    }
    const urls = Array.from(
      { length: count },
      (_, i) => new URL(`cards/card-${String(i + 1).padStart(2, "0")}.jpg`, here).href
    );
    setDeckIn(urls.join("\n"));
  };

  const joinRoom = async () => {
    if (!nameIn.trim()) return setErr("Enter a name first.");
    const c = codeIn.trim().toUpperCase();
    if (c.length !== 4) return setErr("Room codes are 4 letters.");
    setBusy(true);
    setErr("");
    const player = { id: deviceId, name: nameIn.trim().slice(0, 16) };
    const result = await withRoom(c, (s) => applyAction(s, player.id, { type: "join", name: player.name }));
    setBusy(false);
    if (!result.ok) {
      if (result.reason === "not-found") return setErr(`No room named ${c}. Check the code with the host.`);
      if (result.state && result.state.phase !== "lobby")
        return setErr(`Room ${c} is mid-game. Ask the host to go back to the lobby after this game — or create your own room.`);
      return setErr("Couldn't join — try again.");
    }
    saveSeat(c, player);
    setMe(player);
    setCode(c);
    setCore(result.state);
    setScreen("room");
  };

  const start = async () => {
    setErr("");
    const result = await withRoom(code, (s) => applyAction(s, me.id, { type: "start" }));
    if (!result.ok && result.state) {
      const need = result.state.players.length * HAND_SIZE + 4;
      setErr(`Deck too small: need at least ${need} cards.`);
    } else if (result.ok) {
      setCore(result.state);
    }
  };

  const act = (type, extra = {}) => {
    sound.unlock(); // first real click of a session — safe place to unlock audio autoplay
    return withRoom(code, (s) => applyAction(s, me.id, { type, round: s.round, phase: s.phase, ...extra })).then(
      (r) => r.ok && setCore(r.state)
    );
  };

  /* ---- voice clue recording ---- */
  const discardRecording = () => {
    if (recUrl) URL.revokeObjectURL(recUrl);
    setRecBlob(null);
    setRecUrl(null);
    setRecState("idle");
    setRecSecs(0);
  };

  const startRecording = async () => {
    sound.unlock();
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => window.MediaRecorder.isTypeSupported?.(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && recChunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunksRef.current, { type: rec.mimeType || "audio/webm" });
        setRecBlob(blob);
        setRecUrl(URL.createObjectURL(blob));
        setRecState("recorded");
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecState("recording");
      setRecSecs(0);
      recTimerRef.current = setInterval(() => {
        setRecSecs((s) => {
          if (s + 1 >= MAX_REC_S) {
            if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
            clearInterval(recTimerRef.current);
            return MAX_REC_S;
          }
          return s + 1;
        });
      }, 1000);
    } catch (e) {
      const name = e?.name || "";
      const reason =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Your browser blocked the microphone for this site (or the permission pop-up was dismissed). Here's how to allow it:"
          : name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone was found on this device. Check one is connected and not switched off."
          : name === "NotReadableError"
          ? "The microphone is busy — another app (a call, a voice recorder) may be using it. Close that and try again."
          : "The microphone couldn't be started. Here's what usually fixes it:";
      setErr("Microphone not available — see the steps that just opened, or type your clue instead.");
      setMicHelp(reason);
    }
  };

  const stopRecording = () => {
    clearInterval(recTimerRef.current);
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  };

  /* Uploads the clip (if any) then submits the clue — same "Tell it" flow,
     just with an optional voice clip riding alongside the typed text. */
  const tellIt = async () => {
    if (sel === null || (!clueIn.trim() && !recBlob)) return;
    sound.unlock();
    let clueAudioUrl = null;
    if (recBlob) {
      setRecState("uploading");
      const ext = recBlob.type.includes("mp4") ? "m4a" : recBlob.type.includes("ogg") ? "ogg" : "webm";
      const path = `${code}/${core.round}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("clue-audio").upload(path, recBlob, { contentType: recBlob.type });
      if (!error) {
        clueAudioUrl = supabase.storage.from("clue-audio").getPublicUrl(path).data.publicUrl;
      } else {
        setErr("Voice clue didn't upload. (Has the clue-audio Supabase setup been run?) Type a clue instead, or try recording again.");
        if (!clueIn.trim()) {
          setRecState("recorded"); // keep the clip so they can retry rather than silently losing it
          return;
        }
      }
    }
    await act("clue", { card: sel, clue: clueIn.trim(), clueAudioUrl });
    setClueIn("");
    discardRecording();
  };

  /* ---- derived ---- */
  const isHost = core && me && core.hostId === me.id;
  const st = core?.players?.[core.storytellerIdx];
  const iAmSt = st && me && st.id === me.id;
  const myHand = core?.hands?.[me?.id] || [];
  const urlFor = (i) => core?.deckUrls?.[i] || null;

  const page = {
    minHeight: "100vh",
    background: `radial-gradient(1200px 600px at 50% -10%, ${C.night3} 0%, ${C.night} 60%)`,
    color: C.bone,
    fontFamily: "Inter, system-ui, sans-serif",
    padding:
      "max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(96px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))",
    boxSizing: "border-box",
  };
  const display = { fontFamily: "Fraunces, Georgia, serif", fontWeight: 600, letterSpacing: "-0.02em" };

  // open the big card viewer on one card of a row
  const openZoom = (cards, index, opts = {}) =>
    setZoom({ items: cards.map((c) => ({ seed: c.card ?? c, url: urlFor(c.card ?? c), label: c.label })), index, ...opts });

  // the "your move" banner stays until dismissed or until you've made the move
  const tellerNow = core?.players?.[core.storytellerIdx];
  const showTurnAlert =
    !!turnAlert &&
    !!core &&
    !!me &&
    turnAlert.key === `${core.phase}-${core.round}` &&
    ((core.phase === "clue" && tellerNow?.id === me.id) ||
      (core.phase === "submit" && tellerNow?.id !== me.id && !core.submissions.some((s) => s.playerId === me.id)) ||
      (core.phase === "vote" && tellerNow?.id !== me.id && core.votes[me.id] === undefined));
  showTurnRef.current = showTurnAlert;

  const overlays = (
    <>
      {zoom && <Lightbox zoom={zoom} onClose={() => setZoom(null)} />}
      {micHelp !== null && <MicHelp display={display} reason={micHelp} onClose={() => setMicHelp(null)} />}
      {showInstall && (
        <InstallHelp display={display} installPrompt={installPrompt} onInstall={install} onClose={() => setShowInstall(false)} />
      )}
      <div
        style={{
          position: "fixed",
          top: "max(12px, env(safe-area-inset-top))",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(92vw, 440px)",
          zIndex: 55,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "none",
        }}
      >
        {showTurnAlert && (
          <div
            role="alert"
            style={{
              pointerEvents: "auto",
              position: "relative",
              background: C.night2,
              border: `2px solid ${C.amber}`,
              borderRadius: 14,
              padding: "14px 44px 14px 16px",
              boxShadow: `0 14px 44px rgba(0,0,0,.6), 0 0 0 4px ${C.amber}22`,
              color: C.bone,
              animation: "fabelFade .3s ease",
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 2, color: C.amber, marginBottom: 4 }}>🔔 YOUR MOVE</div>
            <div style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 600, fontSize: 19 }}>{turnAlert.title}</div>
            <div style={{ fontSize: 14, color: C.bone, opacity: 0.9, marginTop: 4, lineHeight: 1.45 }}>{turnAlert.body}</div>
            <button
              onClick={() => setTurnAlert(null)}
              aria-label="Dismiss"
              style={{ ...closeXStyle, position: "absolute", top: 6, right: 6, color: C.bone }}
            >
              ✕
            </button>
          </div>
        )}
        {chatToast && !chatOpen && (
          <div
            onClick={() => {
              setChatToast(null);
              toggleChat();
            }}
            role="button"
            style={{
              pointerEvents: "auto",
              background: "#3a1c1f",
              border: "1px solid #e0554f",
              borderRadius: 12,
              padding: "12px 14px",
              boxShadow: "0 12px 40px rgba(0,0,0,.5)",
              color: C.bone,
              fontSize: 14,
              cursor: "pointer",
              animation: "fabelFade .3s ease",
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 2, color: "#ff8a84", marginBottom: 4 }}>❗ IMPORTANT · tap to open chat</div>
            <b style={{ color: C.violet }}>{chatToast.name}</b> {chatToast.text || "🎤 sent a voice message"}
          </div>
        )}
      </div>
    </>
  );

  const chatPanel = (
    <ChatPanel
      open={chatOpen}
      onToggle={toggleChat}
      msgs={chatMsgs}
      myDeviceId={deviceId}
      chatIn={chatIn}
      setChatIn={setChatIn}
      onSend={sendChat}
      unread={chatUnread}
      important={chatImportant}
      setImportant={setChatImportant}
      onSendVoice={sendVoice}
      onMicError={onChatMicError}
      voiceBusy={voiceBusy}
    />
  );

  if (restoring) {
    return (
      <div style={page}>
        <p style={{ textAlign: "center", marginTop: 80, color: C.muted }}>Finding your seat…</p>
      </div>
    );
  }

  /* ---------- HOME ---------- */
  if (screen === "home") {
    return (
      <div style={page}>
        {overlays}
        <div style={{ maxWidth: 460, margin: "0 auto" }}>
          <div style={{ textAlign: "center", padding: "36px 0 28px" }}>
            <div style={{ width: 92, margin: "0 auto 18px" }}>
              <CardBack />
            </div>
            <h1 style={{ ...display, fontSize: 52, margin: 0, lineHeight: 1 }}>DitFofs</h1>
            <p style={{ color: C.muted, marginTop: 10, fontSize: 14 }}>
              Give a clue. Hide your card. Guess the teller.
            </p>
          </div>

          <label style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>YOUR NAME</label>
          <input
            value={nameIn}
            onChange={(e) => setNameIn(e.target.value)}
            placeholder="write your DitFofs name here"
            maxLength={16}
            style={inp}
          />

          <div style={{ marginTop: 26 }}>
            <label style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>JOIN A ROOM</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input
                value={codeIn}
                onChange={(e) => setCodeIn(e.target.value.toUpperCase())}
                placeholder="ABCD"
                maxLength={4}
                style={{ ...inp, marginTop: 0, letterSpacing: 6, textAlign: "center", fontWeight: 600 }}
              />
              <Btn onClick={joinRoom} disabled={busy}>
                Join
              </Btn>
            </div>
          </div>

          <div style={{ margin: "30px 0 18px", display: "flex", alignItems: "center", gap: 12, color: C.muted, fontSize: 12 }}>
            <div style={{ flex: 1, height: 1, background: `${C.muted}33` }} />
            OR
            <div style={{ flex: 1, height: 1, background: `${C.muted}33` }} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>
              CARD IMAGES (optional — one URL per line)
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number"
                min={12}
                max={998}
                value={deckCount}
                onChange={(e) => setDeckCount(Math.max(12, Math.min(998, Number(e.target.value) || 84)))}
                title="How many card-NN.jpg slots to fill in"
                style={{
                  width: 56,
                  boxSizing: "border-box",
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: `1px solid ${C.muted}44`,
                  background: "#0B1A20",
                  color: C.bone,
                  fontSize: 12,
                  fontFamily: "Inter, system-ui, sans-serif",
                }}
              />
              <button onClick={() => autofillDeck(deckCount)} style={{ ...linkBtnStyle, marginLeft: 0 }}>
                USE /cards FOLDER
              </button>
            </div>
          </div>
          <textarea
            value={deckIn}
            onChange={(e) => setDeckIn(e.target.value)}
            rows={3}
            placeholder="Leave empty to use the built-in painted deck"
            style={{ ...inp, resize: "vertical", fontSize: 12 }}
          />
          <p style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
            "Use /cards folder" fills in card-01.jpg … card-{String(deckCount).padStart(2, "0")}.jpg from this
            same site — bump the number on the left as your deck grows past 84. Any card image that fails to
            load just falls back to the painted placeholder for that card.
          </p>
          <div style={{ marginTop: 14 }}>
            <Btn onClick={createRoom} disabled={busy}>
              Create a room
            </Btn>
          </div>

          {err && <p style={{ color: C.amber, fontSize: 13, marginTop: 14 }}>{err}</p>}

          {!isStandalone && (
            <div style={{ marginTop: 34, paddingTop: 18, borderTop: `1px solid ${C.muted}22`, textAlign: "center" }}>
              <Btn tone="ghost" small onClick={() => setShowInstall(true)}>
                📲 Put DitFofs on your home screen
              </Btn>
              <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
                Its own icon on your phone — no more digging through WhatsApp for the link.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!core) return <div style={page}>Loading room…</div>;

  /* ---------- LOBBY ---------- */
  if (core.phase === "lobby") {
    return (
      <div style={page}>
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <Header
            code={core.code}
            display={display}
            onLeave={leave}
            onHelp={() => setShowHelp(true)}
            soundOn={sound.enabled}
            onToggleSound={sound.toggle}
          />
          {showHelp && <HelpPanel display={display} onClose={() => setShowHelp(false)} />}
          <p style={{ color: C.muted, fontSize: 14, marginTop: 18 }}>
            Share the code <b style={{ color: C.bone, letterSpacing: 3 }}>{core.code}</b> — everyone opens
            this same link and taps Join.
          </p>
          <h2 style={{ ...display, fontSize: 22, marginTop: 28 }}>At the table ({core.players.length})</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
            {core.players.map((p) => (
              <li
                key={p.id}
                style={{
                  padding: "12px 14px",
                  background: `${C.night2}cc`,
                  borderRadius: 10,
                  marginBottom: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 15,
                }}
              >
                <span>
                  {p.name} {p.id === me.id && <span style={{ color: C.muted }}>(you)</span>}
                </span>
                {p.id === core.hostId && <span style={{ color: C.amber, fontSize: 12 }}>host</span>}
              </li>
            ))}
          </ul>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 18 }}>
            Deck: {core.deckUrls.length ? `${core.deckUrls.length} of your images` : `${core.deckSize} painted placeholders`}
          </p>
          {isHost ? (
            <div style={{ marginTop: 22 }}>
              <Btn onClick={start} disabled={core.players.length < 3}>
                {core.players.length < 3 ? "Waiting for 3+ players" : "Deal the first hand"}
              </Btn>
            </div>
          ) : (
            <p style={{ color: C.muted, marginTop: 22, fontSize: 14 }}>Waiting for the host to deal…</p>
          )}
          {err && <p style={{ color: C.amber, fontSize: 13, marginTop: 14 }}>{err}</p>}
          <div style={{ marginTop: 28 }}>
            <Btn tone="ghost" small onClick={leave}>
              ← Leave this room
            </Btn>
          </div>
        </div>
        {overlays}
        {chatPanel}
      </div>
    );
  }

  /* ---------- END ---------- */
  if (core.phase === "end") {
    const ranked = [...core.players].sort((a, b) => b.score - a.score);
    return (
      <div style={page}>
        <canvas ref={confettiRef} style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 40 }} />
        <div style={{ maxWidth: 460, margin: "0 auto" }}>
          <Header
            code={core.code}
            display={display}
            onLeave={leave}
            onHelp={() => setShowHelp(true)}
            soundOn={sound.enabled}
            onToggleSound={sound.toggle}
          />
          {showHelp && <HelpPanel display={display} onClose={() => setShowHelp(false)} />}
        </div>
        <div className="fabel-fade" style={{ maxWidth: 460, margin: "0 auto", textAlign: "center" }}>
          <h1 style={{ ...display, fontSize: 40, marginTop: 30 }}>{ranked[0]?.name} wins</h1>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 24 }}>
            {ranked.map((p, i) => (
              <li key={p.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.muted}22`, fontSize: 16 }}>
                <span style={{ color: C.muted, marginRight: 10 }}>{i + 1}</span>
                {p.name} <b style={{ float: "right", color: C.amber }}>{p.score}</b>
              </li>
            ))}
          </ul>

          {isHost ? (
            <div style={{ marginTop: 30, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <Btn onClick={() => act("restart")} disabled={core.players.length < 3}>
                Play again, same table
              </Btn>
              <Btn tone="dark" onClick={() => act("lobby")}>
                Back to the lobby (people can join or leave)
              </Btn>
              {core.players.length < 3 && (
                <p style={{ fontSize: 13, color: C.muted }}>Fewer than 3 players left — go back to the lobby to wait for more.</p>
              )}
            </div>
          ) : (
            <p style={{ marginTop: 28, fontSize: 14, color: C.muted, lineHeight: 1.6 }}>
              {core.players.find((p) => p.id === core.hostId)?.name || "The host"} can start another game. Not staying?
              You're free to go any time.
            </p>
          )}

          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <Btn tone="ghost" onClick={leave}>
              Leave — go back to start
            </Btn>
            <span style={{ fontSize: 12, color: C.muted }}>From there you can create your own room or join another.</span>
          </div>
        </div>
        {overlays}
        {chatPanel}
      </div>
    );
  }

  /* ---------- GAME ---------- */
  const phaseLine = () => {
    if (core.phase === "clue") return iAmSt ? "Your turn to tell" : `${st.name} is choosing a card`;
    if (core.phase === "submit") return iAmSt ? "Waiting for the others" : "Pick a card that fits the clue";
    if (core.phase === "vote") return iAmSt ? "They're voting" : "Which one is the teller's?";
    return "Round over";
  };

  const iSubmitted = core.submissions.some((s) => s.playerId === me.id);
  const iVoted = core.votes[me.id] !== undefined;

  return (
    <LayoutContext.Provider value={{ layout: cardLayout, setLayout: setCardLayout }}>
    <div style={page} className={cardLayout === "grid" ? "fabel-layout-grid" : undefined}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <Header
          code={core.code}
          display={display}
          round={core.round}
          onLeave={leave}
          onHelp={() => setShowHelp(true)}
          soundOn={sound.enabled}
          onToggleSound={sound.toggle}
        />
        {showHelp && <HelpPanel display={display} onClose={() => setShowHelp(false)} />}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          {core.players.map((p) => (
            <div
              key={p.id}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 13,
                background: p.id === st.id ? `${C.violet}33` : `${C.night2}`,
                boxShadow: p.id === st.id ? `inset 0 0 0 1px ${C.violet}88` : "none",
              }}
            >
              {p.id === st.id && "✦ "}
              {p.name} <b style={{ color: C.amber, marginLeft: 4 }}>{p.score}</b>
            </div>
          ))}
        </div>

        <div style={{ textAlign: "center", padding: "34px 10px 26px" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, marginBottom: 10 }}>
            {phaseLine().toUpperCase()}
          </div>
          {core.clue || core.clueAudioUrl ? (
            <div>
              {core.clue && (
                <div style={{ ...display, fontSize: "clamp(26px,6vw,46px)", lineHeight: 1.15, color: C.bone }}>
                  <span style={{ color: C.amber, opacity: 0.6 }}>“</span>
                  {core.clue}
                  <span style={{ color: C.amber, opacity: 0.6 }}>”</span>
                </div>
              )}
              {core.clue && (() => {
                const tr = clueTr?.for === core.clue ? clueTr : null;
                const linkStyle = { ...linkBtnStyle, marginLeft: 0, fontSize: 13, padding: "6px 10px" };
                if (tr?.text)
                  return (
                    <div style={{ marginTop: 10, fontSize: 16, color: C.bone, fontStyle: "italic" }}>
                      🌐 {tr.text}
                      {tr.from && (
                        <div style={{ fontSize: 11, color: C.muted, fontStyle: "normal", marginTop: 4 }}>
                          translated from {langName(tr.from)} · machine translation, may miss the nuance
                        </div>
                      )}
                    </div>
                  );
                if (tr?.failed)
                  return (
                    <a href={translateUrl(core.clue)} target="_blank" rel="noopener noreferrer" style={{ ...linkStyle, display: "inline-block", marginTop: 8 }}>
                      Couldn't translate here — open in Google Translate
                    </a>
                  );
                return (
                  <button
                    disabled={tr?.loading}
                    onClick={async () => {
                      const clue = core.clue;
                      setClueTr({ for: clue, loading: true });
                      try {
                        const r = await translateText(clue);
                        setClueTr({ for: clue, ...r });
                      } catch {
                        setClueTr({ for: clue, failed: true });
                      }
                    }}
                    style={{ ...linkStyle, display: "inline-block", marginTop: 8 }}
                  >
                    {tr?.loading ? "Translating…" : "🌐 Translate this clue"}
                  </button>
                );
              })()}
              {core.clueAudioUrl && (
                <audio
                  controls
                  src={core.clueAudioUrl}
                  style={{ marginTop: core.clue ? 14 : 4, height: 36, maxWidth: 320, width: "100%" }}
                />
              )}
            </div>
          ) : (
            <div style={{ ...display, fontSize: 26, color: C.muted }}>…</div>
          )}
        </div>

        <div key={`${core.phase}-${core.round}`} className="fabel-fade">
        {core.phase === "clue" && iAmSt && (
          <>
            <Row label="Choose one card, then write your clue">
              {myHand.map((c, i) => (
                <Card
                  key={c}
                  seed={c}
                  url={urlFor(c)}
                  selected={sel === c}
                  onClick={() => setSel(c)}
                  onZoom={() =>
                    openZoom(myHand, i, {
                      onPick: (it) => {
                        setSel(it.seed);
                        setTimeout(() => clueInputRef.current?.focus(), 150);
                      },
                      pickLabel: "Use this card for my clue",
                    })
                  }
                />
              ))}
            </Row>
            <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
              <input
                ref={clueInputRef}
                value={clueIn}
                onChange={(e) => setClueIn(e.target.value)}
                placeholder="a word, a phrase, a sound…"
                style={{ ...inp, marginTop: 0, flex: "1 1 240px" }}
              />
              <Btn disabled={sel === null || (!clueIn.trim() && !recBlob) || recState === "uploading"} onClick={tellIt}>
                {recState === "uploading" ? "Sending…" : "Tell it"}
              </Btn>
            </div>

            {!canRecord && (
              <p style={{ marginTop: 12, fontSize: 13, color: C.muted }}>
                🎤 Voice clues aren't available in this browser.{" "}
                <button
                  onClick={() => setMicHelp("This browser can't record audio. Opening the link in Chrome or Safari usually fixes it:")}
                  style={{ ...linkBtnStyle, marginLeft: 0, padding: 0, fontSize: 13 }}
                >
                  Why, and how to fix it
                </button>
              </p>
            )}
            {canRecord && (
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {recState === "idle" && (
                  <>
                    <button
                      onClick={startRecording}
                      style={{ ...linkBtnStyle, marginLeft: 0, textDecoration: "none", fontSize: 13 }}
                    >
                      🎤 or record a voice clue instead
                    </button>
                    <button onClick={() => setMicHelp("")} style={{ ...linkBtnStyle, marginLeft: 0, fontSize: 12 }}>
                      mic not working?
                    </button>
                  </>
                )}
                {recState === "recording" && (
                  <>
                    <span className="fabel-pulse" style={{ width: 10, height: 10, borderRadius: "50%", background: "#e0554f", display: "inline-block" }} />
                    <span style={{ fontSize: 13, color: C.muted }}>
                      Recording… {recSecs}s / {MAX_REC_S}s
                    </span>
                    <Btn small tone="ghost" onClick={stopRecording}>
                      Stop
                    </Btn>
                  </>
                )}
                {recState === "recorded" && recUrl && (
                  <>
                    <audio controls src={recUrl} style={{ height: 32, maxWidth: 220 }} />
                    <button onClick={discardRecording} style={{ ...linkBtnStyle, marginLeft: 0, fontSize: 13 }}>
                      re-record
                    </button>
                  </>
                )}
              </div>
            )}
            {err && <p style={{ color: C.amber, fontSize: 13, marginTop: 10 }}>{err}</p>}
          </>
        )}
        {core.phase === "clue" && !iAmSt && (
          <Row label="Your hand">
            {myHand.map((c, i) => (
              <Card key={c} seed={c} url={urlFor(c)} onZoom={() => openZoom(myHand, i)} />
            ))}
          </Row>
        )}

        {core.phase === "submit" && (
          <>
            {!iAmSt && !iSubmitted && (
              <>
                <Row label="Your hand">
                  {myHand.map((c, i) => (
                    <Card
                      key={c}
                      seed={c}
                      url={urlFor(c)}
                      selected={sel === c}
                      onClick={() => setSel(c)}
                      onZoom={() =>
                        openZoom(myHand, i, {
                          onPick: (it) => {
                            setSel(it.seed);
                            act("submit", { card: it.seed });
                          },
                          pickLabel: "Play this card face down",
                        })
                      }
                    />
                  ))}
                </Row>
                <div style={{ marginTop: 18 }}>
                  <Btn disabled={sel === null} onClick={() => act("submit", { card: sel })}>
                    Play this card face down
                  </Btn>
                </div>
              </>
            )}
            <Waiting
              names={core.players.filter((p) => !core.submissions.some((s) => s.playerId === p.id)).map((p) => p.name)}
              verb="still choosing"
              secsLeft={secsLeft}
            />
          </>
        )}

        {core.phase === "vote" && (
          <>
            <Row label="On the table">
              {core.submissions.map((s, i) => {
                const mine = s.playerId === me.id;
                return (
                  <Card
                    key={s.card}
                    seed={s.card}
                    url={urlFor(s.card)}
                    width={TABLE_CARD_W}
                    flip
                    flipDelay={i * 90}
                    dim={mine && !iAmSt}
                    selected={sel === s.card}
                    badge={mine ? "yours" : undefined}
                    onClick={!iAmSt && !iVoted && !mine ? () => setSel(s.card) : undefined}
                    onZoom={() =>
                      openZoom(
                        core.submissions.map((x) => ({ card: x.card, label: x.playerId === me.id ? "yours" : undefined })),
                        i,
                        !iAmSt && !iVoted
                          ? {
                              onPick: (it) => {
                                setSel(it.seed);
                                act("vote", { card: it.seed });
                              },
                              canPick: (it) => it.label !== "yours",
                              pickLabel: "Vote for this one",
                              cantPickNote: "That's your own card — swipe to another one",
                            }
                          : {}
                      )
                    }
                  />
                );
              })}
            </Row>
            {!iAmSt && !iVoted && (
              <div style={{ marginTop: 18 }}>
                <Btn disabled={sel === null} onClick={() => act("vote", { card: sel })}>
                  Vote for this one
                </Btn>
              </div>
            )}
            <Waiting
              names={core.players.filter((p) => p.id !== st.id && core.votes[p.id] === undefined).map((p) => p.name)}
              verb="still voting"
              secsLeft={secsLeft}
            />
          </>
        )}

        {core.phase === "reveal" && core.result && (
          <>
            <Row label="">
              {core.submissions.map((s, i) => {
                const owner = core.players.find((p) => p.id === s.playerId);
                const voters = Object.entries(core.votes)
                  .filter(([, c]) => c === s.card)
                  .map(([vid]) => core.players.find((p) => p.id === vid)?.name)
                  .filter(Boolean);
                const isSt = s.card === core.result.stCard;
                return (
                  <div key={s.card} style={{ flex: "0 0 auto", width: TABLE_CARD_W }}>
                    <div
                      className={isSt ? "fabel-pulse" : undefined}
                      style={{ outline: isSt ? `3px solid ${C.violet}` : "none", borderRadius: 12 }}
                    >
                      <Card
                        seed={s.card}
                        url={urlFor(s.card)}
                        width="100%"
                        flip
                        flipDelay={i * 90}
                        onZoom={() =>
                          openZoom(
                            core.submissions.map((x) => ({
                              card: x.card,
                              label: `${core.players.find((p) => p.id === x.playerId)?.name || ""}${x.card === core.result.stCard ? " ✦" : ""}`,
                            })),
                            i
                          )
                        }
                      />
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
                      <div style={{ color: isSt ? C.violet : C.bone, fontWeight: 600 }}>
                        {owner?.name}
                        {isSt && " ✦"}
                      </div>
                      <div style={{ color: C.muted }}>{voters.length ? `voted by ${voters.join(", ")}` : "no votes"}</div>
                    </div>
                  </div>
                );
              })}
            </Row>
            <div style={{ marginTop: 24, fontSize: 14, color: C.muted }}>
              {core.result.allOrNone
                ? `${st.name}'s clue was ${core.result.correctIds.length ? "too easy" : "too hard"} — no points for the teller.`
                : `${st.name} scores. Correct guesses: ${
                    core.result.correctIds.map((i) => core.players.find((p) => p.id === i)?.name).join(", ") || "none"
                  }.`}
            </div>
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
              {core.players.map((p) => (
                <span key={p.id} style={{ fontSize: 13 }}>
                  {p.name} <b style={{ color: core.result.gains[p.id] ? C.green : C.muted }}>+{core.result.gains[p.id]}</b>
                </span>
              ))}
            </div>
            {isHost && (
              <div style={{ marginTop: 24 }}>
                <Btn onClick={() => act("next")}>Next round</Btn>
              </div>
            )}
          </>
        )}
        </div>
      </div>
      {overlays}
      {chatPanel}
    </div>
    </LayoutContext.Provider>
  );
}
