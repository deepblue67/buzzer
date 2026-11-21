// Maître du jeu : c'est lui qui fait foi (horloge de référence + état de la partie).
import { createTransport } from './transport.js';
import * as G from './game.js';
import { now, getRoom, makeRoomCode, link, absUrl, store, esc, $, toast, keepAwake, setConn, qrSvg } from './common.js';
import { queueHtml, boardHtml, podiumHtml, phaseLabel, avatarBubble, flipRender } from './ui.js';
import * as FX from './fx.js';

// ---------- Salle ----------
let room = getRoom();
if (!room) {
  location.replace(link('host.html', { r: makeRoomCode() }));
  await new Promise(() => {}); // stoppe le module pendant la redirection
}
const SAVE_KEY = 'buzzer-host:' + room;
store.set('buzzer-last-host-room', room);

let state = store.get(SAVE_KEY) || G.newGame(room, now());
const undoStack = [];
const rtts = new Map(); // id joueur -> latence aller-retour connue
let online = new Set();
let soundOn = store.get('buzzer-host-sound', true);
FX.setMuted(!soundOn);
const inst = G.randomId(6);
const joinUrl = absUrl('play.html', { r: room });

const tr = createTransport(room, {
  key: 'host-' + inst,
  meta: { role: 'host', inst },
  onStatus: (s) => {
    setConn(s, tr.local);
    if (s === 'online') broadcastState();
  },
});

// ---------- État ----------
let bcTimer = null;
function broadcastState() {
  clearTimeout(bcTimer);
  bcTimer = setTimeout(() => tr.send('state', { state, th: now() }), 25);
}

function commit(next, { undo = false } = {}) {
  if (!next || next === state) return false;
  if (undo) {
    undoStack.push(state);
    if (undoStack.length > 40) undoStack.shift();
  }
  next.v = state.v + 1;
  state = next;
  store.set(SAVE_KEY, state);
  scheduleTimers();
  render();
  broadcastState();
  return true;
}

function fx(kind, id = null) {
  tr.send('fx', { kind, id, qn: state.q.n });
}

let freezeTimer = null;
let openTimer = null;
function scheduleTimers() {
  clearTimeout(freezeTimer);
  clearTimeout(openTimer);
  const q = state.q;
  if (q.graceUntil != null) {
    freezeTimer = setTimeout(() => commit(G.freeze(state, now())), Math.max(0, q.graceUntil - now()) + 10);
  }
  if (q.phase === 'countdown') {
    openTimer = setTimeout(() => {
      if (commit(G.openIfDue(state, now()))) {
        FX.play('go');
      }
    }, Math.max(0, q.openAt - now()) + 5);
  }
}

// ---------- Messages ----------
tr.on('ping', ({ id, n, t0 }) => tr.send('pong', { to: id, n, t0, th: now() }));

tr.on('need-state', broadcastState);

tr.on('hello', (m) => {
  if (m.role === 'tv') return broadcastState();
  if (Number.isFinite(m.rtt)) rtts.set(m.id, m.rtt);
  const isNew = !state.players[m.id];
  const next = G.upsertPlayer(state, m, now(), { rejoin: !!m.rejoin });
  if (!next) return broadcastState(); // joueur exclu : il verra qu'il n'est plus dans la partie
  const changed = JSON.stringify(next.players[m.id]) !== JSON.stringify(state.players[m.id]) || next.kicked.length !== state.kicked.length;
  if (changed) {
    commit(next);
    if (isNew) {
      FX.play('join');
      fx('join', m.id);
    }
  } else broadcastState();
});

tr.on('buzz', (m) => {
  const arrival = now();
  if (Number.isFinite(m.rtt)) rtts.set(m.id, m.rtt);
  const live = [...online].map((id) => rtts.get(id)).filter(Number.isFinite);
  const wasEmpty = state.q.queue.length === 0;
  const r = G.applyBuzz(state, m, arrival, { graceMs: G.graceMsFor(live) });
  if (!r.ok) {
    if (r.reason !== 'dup') broadcastState(); // le joueur se resynchronise sur l'état réel
    return;
  }
  commit(r.state);
  if (wasEmpty) {
    const p = state.players[m.id];
    FX.play(p?.sound || 'klaxon');
    FX.vibrate(80);
  }
});

tr.onPresence((list) => {
  online = new Set(list.filter((m) => m.role === 'player').map((m) => m.id));
  const otherHost = list.some((m) => m.role === 'host' && m.inst !== inst);
  $('#dupHost').hidden = !otherHost;
  render();
});

// Retour de veille : on redemande une synchro d'horloge à tout le monde.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    tr.send('resync', {});
    broadcastState();
  }
});
setInterval(broadcastState, 5000);

// ---------- Actions ----------
/** Joueurs inscrits ET connectés en ce moment. */
const connectedCount = () => [...online].filter((id) => state.players[id]).length;
function canStart() {
  if (connectedCount() > 0) return true;
  toast('Il faut au moins un joueur connecté 🙂');
  return false;
}

const actions = {
  next() {
    if (!canStart()) return;
    commit(G.nextQuestion(state, now()), { undo: true });
    if (state.q.phase === 'open') {
      FX.play('go');
      fx('open');
    }
  },
  top() {
    if (!canStart()) return;
    commit(G.top(state, now()), { undo: true });
    if (state.q.phase === 'open') {
      FX.play('go');
      fx('open');
    }
  },
  right() {
    const id = state.q.queue[G.headIndex(state.q)]?.id;
    if (commit(G.judge(state, true, now()), { undo: true })) {
      FX.play('right');
      FX.confetti({ colors: [state.players[id]?.color || '#ffd60a', '#ffd60a', '#ffffff', '#2ec4b6'] });
      fx('right', id);
    }
  },
  wrong() {
    const id = state.q.queue[G.headIndex(state.q)]?.id;
    if (commit(G.judge(state, false, now()), { undo: true })) {
      FX.play('wrong');
      FX.shake($('#stage'));
      fx('wrong', id);
    }
  },
  noone() {
    commit(G.noOne(state), { undo: true });
    fx('noone');
  },
  undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    commit(structuredClone(prev));
    toast('↩️ Action annulée');
  },
  podium() {
    commit(G.setPodium(state, true), { undo: true });
    FX.play('fanfare');
    FX.confetti({ count: 240 });
    fx('podium');
  },
  unpodium() {
    commit(G.setPodium(state, false));
  },
  reset() {
    if (!confirm('Remettre tous les scores à zéro (les joueurs restent inscrits) ?')) return;
    commit(G.resetScores(state), { undo: true });
    closeModal();
    toast('Scores remis à zéro');
  },
  newroom() {
    if (!confirm('Créer une nouvelle salle ? Les joueurs devront rescanner le QR code.')) return;
    location.href = link('host.html', { r: makeRoomCode() });
  },
  qr() {
    openModal('#qrModal');
  },
  settings() {
    syncSettingsForm();
    openModal('#setModal');
  },
  close() {
    closeModal();
  },
};

document.addEventListener('click', (e) => {
  FX.unlockAudio();
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  const id = b.dataset.id;
  if (act === 'plus') return commit(G.adjustScore(state, id, 1), { undo: true });
  if (act === 'minus') return commit(G.adjustScore(state, id, -1), { undo: true });
  if (act === 'kick') {
    const p = state.players[id];
    if (p && confirm(`Exclure ${p.name} de la partie ?`)) commit(G.kick(state, id), { undo: true });
    return;
  }
  actions[act]?.();
});

// Clavier (pratique si le maître du jeu est sur PC) : Entrée = suivante/Top, B = bonne, M = mauvaise, U = annuler
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  const q = state.q;
  if (k === 'enter') {
    if (q.phase === 'ready') actions.top();
    else if (q.phase === 'resolved' || q.phase === 'lobby') actions.next();
  } else if (k === 'b' && G.isHeadFrozen(q)) actions.right();
  else if (k === 'm' && G.isHeadFrozen(q)) actions.wrong();
  else if (k === 'u') actions.undo();
});

// ---------- Modales & réglages ----------
function openModal(sel) {
  $(sel).classList.add('open');
}
function closeModal() {
  document.querySelectorAll('.modal.open').forEach((m) => m.classList.remove('open'));
}
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => {
    if (e.target === m) closeModal();
  })
);

function syncSettingsForm() {
  const f = $('#setForm');
  f.malus.checked = state.settings.malus;
  f.falseStart.checked = state.settings.falseStart;
  f.openMode.value = state.settings.openMode;
  f.sound.checked = soundOn;
  $('#tvLink').href = link('tv.html', { r: room });
  $('#tvUrl').textContent = absUrl('tv.html', { r: room });
}
$('#setForm').addEventListener('change', (e) => {
  const f = e.currentTarget;
  if (e.target.name === 'sound') {
    soundOn = f.sound.checked;
    store.set('buzzer-host-sound', soundOn);
    FX.setMuted(!soundOn);
    return;
  }
  commit(G.setSettings(state, { malus: f.malus.checked, falseStart: f.falseStart.checked, openMode: f.openMode.value }));
});

// ---------- Rendu ----------
function stageHtml() {
  const q = state.q;
  const players = Object.keys(state.players).length;
  const live = connectedCount();
  const dis = live ? '' : 'disabled';
  const waitMsg = live ? '' : '<p class="muted">⏳ En attente d’au moins un joueur connecté…</p>';
  if (state.podium) {
    return `${podiumHtml(state)}<div class="row"><button class="btn big" data-act="unpodium">↩️ Revenir au jeu</button><button class="btn ghost" data-act="reset">🔄 Nouvelle partie</button></div>`;
  }
  switch (q.phase) {
    case 'lobby':
      return `<div class="lobby">
        <div class="qrbox small" data-act="qr">${qrSvg(joinUrl)}</div>
        <div><p class="big-txt">Code <b class="code">${room}</b></p>
        <p class="muted">${live ? `${live} joueur${live > 1 ? 's' : ''} connecté${live > 1 ? 's' : ''} 🎉` : 'Les joueurs scannent le QR code pour s’inscrire.'}</p></div></div>
        ${waitMsg}<button class="btn big go" data-act="next" ${dis}>▶ Première question</button>`;
    case 'ready':
      return `<p class="phase">Question ${q.n}</p><p class="big-txt">📣 Lis ta question…</p>
        ${waitMsg}<button class="btn huge go" data-act="top" ${dis}>🟢 TOP !</button>
        <button class="btn ghost" data-act="noone">⏭ Passer</button>`;
    case 'countdown':
      return `<p class="phase">Question ${q.n}</p><div class="countdown" id="cd">3</div>`;
    case 'open': {
      const h = G.headIndex(q);
      if (h < 0) {
        const locked = q.locked.length;
        return `<p class="phase">Question ${q.n}</p><p class="big-txt">🔔 Buzzers ouverts</p>
          ${live ? '<div class="timer" id="timer">0,0 s</div>' : '<p class="big-txt muted">⏸ Plus aucun joueur connecté</p>'}
          ${locked ? `<p class="muted">${locked} joueur${locked > 1 ? 's' : ''} éliminé${locked > 1 ? 's' : ''} sur cette question</p>` : ''}
          <button class="btn ghost" data-act="noone">🤷 Personne ne trouve</button>`;
      }
      const e = q.queue[h];
      const p = state.players[e.id] || { name: '?', avatar: '❔', color: '#888' };
      const frozen = G.isHeadFrozen(q);
      return `<p class="phase">Question ${q.n} · ${h === 0 ? 'premier buzz' : `${h + 1}e de la file`}</p>
        <div class="who" style="--c:${esc(p.color)}">${avatarBubble(p, 'xl')}<div><div class="who-name">${esc(p.name)}</div><div class="who-time">${G.formatSeconds(e.rt)}</div></div></div>
        ${frozen ? '<p class="big-txt">🎤 À toi de juger sa réponse</p>' : '<p class="big-txt muted">⏳ On vérifie l’ordre des buzz…</p>'}
        <div class="judge"><button class="btn huge ok" data-act="right" ${frozen ? '' : 'disabled'}>✅ Bonne</button>
        <button class="btn huge ko" data-act="wrong" ${frozen ? '' : 'disabled'}>❌ Fausse</button></div>
        <button class="btn ghost" data-act="noone">🤷 Personne ne trouve</button>`;
    }
    case 'resolved': {
      const w = q.winner && state.players[q.winner];
      return `<p class="phase">Question ${q.n}</p>
        ${w ? `<div class="who win" style="--c:${esc(w.color)}">${avatarBubble(w, 'xl')}<div><div class="who-name">${esc(w.name)}</div><div class="who-time">+1 point · ${w.score} au total</div></div></div>` : '<p class="big-txt">🤷 Personne n’a trouvé</p>'}
        ${waitMsg}<button class="btn huge go" data-act="next" ${dis}>▶ Question suivante</button>`;
    }
  }
  return '';
}

let lastStageKey = '';
function render() {
  const q = state.q;
  // On ne reconstruit la zone principale que si elle change (évite de "manger" un appui).
  const stageKey = JSON.stringify([state.podium, q.n, q.phase, q.queue.map((e) => [e.id, e.res]), q.frozen, q.winner, q.locked.length, Object.keys(state.players).length, state.players[q.winner]?.score, connectedCount()]);
  if (stageKey !== lastStageKey) {
    $('#stage').innerHTML = stageHtml();
    $('#stage').dataset.phase = state.podium ? 'podium' : q.phase;
    lastStageKey = stageKey;
  }
  $('#roomCode').textContent = room;
  $('#roomCode2').textContent = room;
  $('#online').textContent = `${online.size} connecté${online.size > 1 ? 's' : ''}`;
  $('#qTitle').textContent = phaseLabel(state);
  $('#queueCard').hidden = q.phase === 'lobby' || state.podium;
  flipRender($('#queue'), queueHtml(state, { empty: q.phase === 'open' ? 'Personne n’a encore buzzé…' : '—' }));
  flipRender($('#board'), boardHtml(state, { online, host: true }));
  $('#undoBtn').disabled = !undoStack.length;
}

// Chronomètre et compte à rebours
setInterval(() => {
  const q = state.q;
  const t = $('#timer');
  if (t && q.phase === 'open' && q.openedAt) t.textContent = ((now() - q.openedAt) / 1000).toFixed(1).replace('.', ',') + ' s';
  const cd = $('#cd');
  if (cd && q.phase === 'countdown') {
    const left = Math.ceil((q.openAt - now()) / 1000);
    if (cd.textContent !== String(Math.max(1, left))) {
      cd.textContent = Math.max(1, left);
      FX.play('tick');
    }
  }
}, 100);

// Au rechargement : rattraper les minuteurs éventuellement dépassés.
state = G.openIfDue(G.freeze(state, now()), now());
scheduleTimers();
$('#qrBig').innerHTML = qrSvg(joinUrl);
$('#joinUrl').textContent = joinUrl.replace(/^https?:\/\//, '');
render();
keepAwake();
