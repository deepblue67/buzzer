// Règles du jeu. Module pur (aucun accès au DOM ni au réseau) : le maître du jeu
// est le seul à appliquer ces fonctions, puis il diffuse l'état à tout le monde.
// Chaque fonction reçoit un état et renvoie un NOUVEL état (l'original n'est pas modifié).

export const DEFAULT_SETTINGS = {
  malus: false, // −1 point pour une mauvaise réponse
  openMode: 'instant', // 'instant' | 'manual' | 'countdown'
  falseStart: true, // buzzer bloqué 1 s si on buzze avant l'ouverture
};

export const COUNTDOWN_MS = 3000;

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

export function randomId(len = 10) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function emptyQuestion(n) {
  return {
    n,
    phase: n === 0 ? 'lobby' : 'ready',
    openedAt: null,
    openAt: null,
    queue: [], // [{ id, t, rt, at, res: null | 'right' | 'wrong' }]
    locked: [], // joueurs qui se sont trompés sur cette question
    winner: null,
    frozen: 0, // nombre d'entrées en tête de file qui ne peuvent plus être doublées
    graceUntil: null, // fin de la fenêtre de grâce en cours (heure hôte)
  };
}

function freshStats() {
  return { score: 0, correct: 0, wrong: 0, buzzes: 0, fastest: null, streak: 0, bestStreak: 0 };
}

export function newGame(room, now, settings = {}) {
  return {
    gid: randomId(8),
    v: 0,
    room,
    createdAt: now,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players: {},
    kicked: [],
    q: emptyQuestion(0),
    podium: false,
  };
}

// ---------- Joueurs ----------

export function upsertPlayer(state, profile, now, { rejoin = false } = {}) {
  const { id } = profile;
  if (!id) return null;
  if (state.kicked.includes(id) && !rejoin) return null;
  const s = clone(state);
  s.kicked = s.kicked.filter((k) => k !== id);
  const fields = {
    name: String(profile.name || 'Joueur').slice(0, 16),
    avatar: String(profile.avatar || '🙂').slice(0, 8),
    color: String(profile.color || '#ff4d6d').slice(0, 16),
    sound: String(profile.sound || 'klaxon').slice(0, 16),
  };
  if (s.players[id]) Object.assign(s.players[id], fields);
  else s.players[id] = { id, ...fields, ...freshStats(), joinedAt: now };
  return s;
}

export function kick(state, id) {
  const s = clone(state);
  delete s.players[id];
  if (!s.kicked.includes(id)) s.kicked.push(id);
  const idx = s.q.queue.findIndex((e) => e.id === id);
  if (idx >= 0 && !s.q.queue[idx].res) {
    s.q.queue.splice(idx, 1);
    if (idx < s.q.frozen) s.q.frozen -= 1;
  }
  return s;
}

export function adjustScore(state, id, delta) {
  if (!state.players[id]) return state;
  const s = clone(state);
  s.players[id].score += delta;
  return s;
}

export function resetScores(state) {
  const s = clone(state);
  for (const p of Object.values(s.players)) Object.assign(p, freshStats());
  s.q = emptyQuestion(0);
  s.podium = false;
  return s;
}

export function setSettings(state, patch) {
  const s = clone(state);
  s.settings = { ...s.settings, ...patch };
  return s;
}

export function setPodium(state, on) {
  const s = clone(state);
  s.podium = !!on;
  return s;
}

// ---------- Déroulé d'une question ----------

export function nextQuestion(state, now) {
  const s = clone(state);
  s.q = emptyQuestion(s.q.n + 1);
  s.podium = false;
  if (s.settings.openMode === 'instant') {
    s.q.phase = 'open';
    s.q.openedAt = now;
  }
  return s;
}

/** « Top ! » : ouvre les buzzers (tout de suite ou après le compte à rebours). */
export function top(state, now) {
  if (state.q.phase !== 'ready') return state;
  const s = clone(state);
  if (s.settings.openMode === 'countdown') {
    s.q.phase = 'countdown';
    s.q.openAt = now + COUNTDOWN_MS;
  } else {
    s.q.phase = 'open';
    s.q.openedAt = now;
  }
  return s;
}

/** À appeler quand le compte à rebours est terminé. */
export function openIfDue(state, now) {
  if (state.q.phase !== 'countdown' || now < state.q.openAt - 5) return state;
  const s = clone(state);
  s.q.phase = 'open';
  s.q.openedAt = s.q.openAt;
  return s;
}

export function headIndex(q) {
  return q.queue.findIndex((e) => !e.res);
}

export function isHeadFrozen(q) {
  const h = headIndex(q);
  return h >= 0 && h < q.frozen;
}

/** Durée de la fenêtre de grâce selon la latence des joueurs connectés. */
export function graceMsFor(rtts) {
  const max = rtts.length ? Math.max(...rtts) : 200;
  return Math.round(Math.min(800, Math.max(300, max / 2 + 150)));
}

/**
 * Un buzz arrive chez le maître du jeu.
 * buzz = { id, t (heure hôte de l'appui), rtt, qn }, arrival = heure hôte de réception.
 * Renvoie { state, ok, reason, startGrace }.
 */
export function applyBuzz(state, buzz, arrival, { graceMs = 300 } = {}) {
  const q = state.q;
  const p = state.players[buzz.id];
  if (!p) return { state, ok: false, reason: 'unknown' };
  if (buzz.qn !== q.n) return { state, ok: false, reason: 'stale' };
  if (q.phase !== 'open') return { state, ok: false, reason: 'closed' };
  if (q.locked.includes(buzz.id)) return { state, ok: false, reason: 'locked' };
  if (q.queue.some((e) => e.id === buzz.id)) return { state, ok: false, reason: 'dup' };

  // Garde-fou : l'heure annoncée doit être plausible compte tenu de l'heure
  // d'arrivée et de la latence connue du joueur (impossible de "remonter le temps").
  const rtt = Number.isFinite(buzz.rtt) ? Math.min(Math.max(buzz.rtt, 0), 3000) : 500;
  let t = Number.isFinite(buzz.t) ? buzz.t : arrival;
  t = Math.min(t, arrival + 30);
  t = Math.max(t, arrival - (rtt + 400));
  t = Math.max(t, q.openedAt);

  const s = clone(state);
  const sq = s.q;
  const entry = { id: buzz.id, t, rt: Math.max(0, t - sq.openedAt), at: arrival, res: null };
  let pos = sq.queue.length;
  for (let i = sq.frozen; i < sq.queue.length; i++) {
    if (sq.queue[i].t > t) {
      pos = i;
      break;
    }
  }
  sq.queue.splice(pos, 0, entry);

  const sp = s.players[buzz.id];
  sp.buzzes += 1;
  sp.fastest = sp.fastest == null ? entry.rt : Math.min(sp.fastest, entry.rt);

  let startGrace = false;
  const h = headIndex(sq);
  if (h >= sq.frozen && sq.graceUntil == null) {
    sq.graceUntil = arrival + graceMs;
    startGrace = true;
  }
  return { state: s, ok: true, reason: 'added', startGrace, entry };
}

/** Fin de la fenêtre de grâce : la tête de file est figée. */
export function freeze(state, now) {
  const q = state.q;
  if (q.graceUntil == null || now < q.graceUntil - 5) return state;
  const s = clone(state);
  const h = headIndex(s.q);
  if (h >= 0) s.q.frozen = Math.max(s.q.frozen, h + 1);
  s.q.graceUntil = null;
  return s;
}

/** Le maître du jeu valide (ok = true) ou refuse la réponse du premier de la file. */
export function judge(state, ok, now) {
  const q = state.q;
  if (q.phase !== 'open' || !isHeadFrozen(q)) return state;
  const s = clone(state);
  const sq = s.q;
  const h = headIndex(sq);
  const e = sq.queue[h];
  const p = s.players[e.id];
  if (ok) {
    e.res = 'right';
    sq.winner = e.id;
    sq.phase = 'resolved';
    sq.graceUntil = null;
    for (const other of Object.values(s.players)) if (other.id !== e.id) other.streak = 0;
    if (p) {
      p.score += 1;
      p.correct += 1;
      p.streak += 1;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
    }
  } else {
    e.res = 'wrong';
    sq.locked.push(e.id);
    if (p) {
      p.wrong += 1;
      p.streak = 0;
      if (s.settings.malus) p.score -= 1;
    }
    // Les suivants sont arrivés depuis longtemps : le nouveau premier est figé tout de suite.
    const nh = headIndex(sq);
    if (nh >= 0) sq.frozen = Math.max(sq.frozen, nh + 1);
    else sq.frozen = sq.queue.length;
  }
  return s;
}

/** Personne n'a trouvé : on clôt la question. */
export function noOne(state) {
  if (state.q.phase === 'resolved' || state.q.phase === 'lobby') return state;
  const s = clone(state);
  s.q.phase = 'resolved';
  s.q.winner = null;
  s.q.graceUntil = null;
  for (const p of Object.values(s.players)) p.streak = 0;
  return s;
}

// ---------- Classement & trophées ----------

export function ranking(state) {
  const list = Object.values(state.players).sort(
    (a, b) => b.score - a.score || b.correct - a.correct || a.joinedAt - b.joinedAt
  );
  let rank = 0;
  let prev = null;
  return list.map((p, i) => {
    if (prev === null || p.score !== prev) rank = i + 1;
    prev = p.score;
    return { ...p, rank };
  });
}

export function awards(state) {
  const ps = Object.values(state.players);
  const out = [];
  const pick = (arr, key, dir = 'max', filter = () => true) => {
    const c = arr.filter(filter);
    if (!c.length) return null;
    return c.reduce((best, p) => (dir === 'max' ? (p[key] > best[key] ? p : best) : p[key] < best[key] ? p : best));
  };
  const champ = pick(ps, 'score', 'max', (p) => p.score > 0);
  if (champ) out.push({ icon: '🏆', title: 'Champion·ne', p: champ, detail: `${champ.score} pt${Math.abs(champ.score) > 1 ? 's' : ''}` });
  const fast = pick(ps, 'fastest', 'min', (p) => p.fastest != null);
  if (fast) out.push({ icon: '⚡', title: 'Gâchette la plus rapide', p: fast, detail: formatSeconds(fast.fastest) });
  const streak = pick(ps, 'bestStreak', 'max', (p) => p.bestStreak >= 2);
  if (streak) out.push({ icon: '🔥', title: 'Plus longue série', p: streak, detail: `${streak.bestStreak} d'affilée` });
  const sharp = ps
    .filter((p) => p.correct + p.wrong >= 2)
    .map((p) => ({ p, r: p.correct / (p.correct + p.wrong) }))
    .sort((a, b) => b.r - a.r || b.p.correct - a.p.correct)[0];
  if (sharp && sharp.r > 0) out.push({ icon: '🎯', title: 'Le plus précis', p: sharp.p, detail: `${Math.round(sharp.r * 100)} % de bonnes réponses` });
  const oops = pick(ps, 'wrong', 'max', (p) => p.wrong > 0);
  if (oops) out.push({ icon: '🙈', title: 'Roi·reine du buzz raté', p: oops, detail: `${oops.wrong} raté${oops.wrong > 1 ? 's' : ''}` });
  return out;
}

export function formatSeconds(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  return (ms / 1000).toFixed(2).replace('.', ',') + ' s';
}
