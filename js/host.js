// Maître du jeu : c'est lui qui fait foi (horloge de référence + état de la partie).
import { createTransport } from './transport.js';
import * as G from './game.js';
import { now, getRoom, makeRoomCode, link, absUrl, store, esc, $, toast, keepAwake, setConn, qrSvg, AVATARS, COLORS } from './common.js';
import { createRosterStore } from './roster.js';
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

const roster = createRosterStore(store); // joueurs enregistrés et groupes (sur ce téléphone)
let state = store.get(SAVE_KEY) || G.newGame(room, now(), { group: store.get('buzzer-group', '') });
if (state.settings.group && !roster.group(state.settings.group)) state.settings.group = '';
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
  bcTimer = setTimeout(() => tr.send('state', { state, th: now(), pick: pickList() }), 25);
}

/** Prénoms proposés dans le « Qui es-tu ? » des téléphones : joueurs enregistrés du groupe qui joue. */
function pickList() {
  return roster.inGroup(state.settings.group).map(({ id, name, avatar, color }) => ({ id, name, avatar, color }));
}
const sameName = (a, b) => String(a).toLocaleLowerCase('fr') === String(b).toLocaleLowerCase('fr');

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

function fx(kind, id = null, extra = {}) {
  tr.send('fx', { kind, id, qn: state.q.n, ...extra });
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
  const name = String(m.name || '').trim().slice(0, 16);
  if (!name) return;
  // Un prénom = un joueur : refusé si quelqu'un de connecté l'utilise déjà,
  // sinon (ancien téléphone déconnecté) ce téléphone reprend sa place et ses points.
  let base = state;
  const clash = Object.values(state.players).find((p) => p.id !== m.id && sameName(p.name, name));
  if (clash) {
    if (online.has(clash.id)) return tr.send('join-err', { to: m.id, msg: `${clash.name} est déjà dans la partie 🙂 Choisis un autre prénom.` });
    base = G.movePlayer(state, clash.id, m.id);
  }
  const isNew = !state.players[m.id] && !clash;
  const next = G.upsertPlayer(base, { ...m, name }, now(), { rejoin: !!m.rejoin });
  // Joueur enregistré qui change son animal ou sa couleur sur son téléphone : on le retient.
  const r = m.rid && roster.players.find((x) => x.id === m.rid);
  if (next && r && sameName(r.name, name) && (r.avatar !== m.avatar || r.color !== m.color)) {
    roster.update(r.id, { avatar: m.avatar, color: m.color });
    renderRoster();
  }
  if (!next) return broadcastState(); // joueur exclu : il verra qu'il n'est plus dans la partie
  const changed = base !== state || JSON.stringify(next.players[m.id]) !== JSON.stringify(state.players[m.id]) || next.kicked.length !== state.kicked.length;
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
/** Une partie a eu lieu : au moins une question a été posée. */
const hasPlayed = () => state.q.n >= 1;
/** Quelqu'un a marqué au moins un point (sinon, pas de feu d'artifice). */
const anyScore = () => Object.values(state.players).some((p) => p.correct > 0);

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
    if (!hasPlayed()) return toast('Aucune question n’a encore été jouée 🙂');
    commit(G.setPodium(state, true), { undo: true });
    const party = anyScore();
    if (party) {
      FX.play('fanfare');
      FX.confetti({ count: 240 });
    }
    fx('podium', null, { party });
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
  if (act.startsWith('r') && rosterActs[act]) return rosterActs[act](b);
  if (act === 'group') {
    store.set('buzzer-group', b.dataset.g);
    return commit(G.setSettings(state, { group: b.dataset.g }));
  }
  if (act === 'fix') {
    fixing = !fixing;
    return render();
  }
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

// ---------- Joueurs enregistrés & groupes ----------
let rFilter = '';
let rGroupsOpen = false;
const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
function rosterChanged() {
  renderRoster();
  lastStageKey = '';
  render();
  broadcastState();
}
function tryRoster(fn) {
  try {
    fn();
    rosterChanged();
  } catch (err) {
    toast(err.message);
  }
}
const rosterActs = {
  roster() {
    renderRoster();
    openModal('#rosterModal');
  },
  rFilter: (b) => {
    rFilter = b.dataset.g;
    renderRoster();
  },
  rGroups: () => {
    rGroupsOpen = !rGroupsOpen;
    renderRoster();
  },
  rAvatar: (b) => tryRoster(() => roster.update(b.dataset.id, { avatar: cycle(AVATARS, roster.players.find((p) => p.id === b.dataset.id)?.avatar) })),
  rColor: (b) => tryRoster(() => roster.update(b.dataset.id, { color: cycle(COLORS, roster.players.find((p) => p.id === b.dataset.id)?.color) })),
  rToggle: (b) => tryRoster(() => roster.toggleGroup(b.dataset.id, b.dataset.g)),
  rDel: (b) => {
    const p = roster.players.find((x) => x.id === b.dataset.id);
    if (p && confirm(`Supprimer ${p.name} de la liste des joueurs enregistrés ?`)) tryRoster(() => roster.remove(p.id));
  },
  rAdd: () => {
    const el = $('#rNew');
    const used = roster.players;
    tryRoster(() => {
      roster.add(el.value, {
        groupId: rFilter || state.settings.group,
        avatar: AVATARS.find((a) => !used.some((p) => p.avatar === a)),
        color: COLORS.find((c) => !used.some((p) => p.color === c)) || COLORS[used.length % COLORS.length],
      });
    });
    setTimeout(() => $('#rNew')?.focus(), 0);
  },
  rgIcon: (b) => tryRoster(() => roster.cycleGroupIcon(b.dataset.g)),
  rgAdd: () => tryRoster(() => roster.addGroup($('#gNew').value)),
  rgDel: (b) => {
    const g = roster.group(b.dataset.g);
    if (!g || !confirm(`Supprimer le groupe ${g.icon} ${g.name} ? Les joueurs ne sont pas supprimés : ils quittent seulement ce groupe.`)) return;
    tryRoster(() => {
      roster.removeGroup(g.id);
      if (rFilter === g.id) rFilter = '';
      if (state.settings.group === g.id) commit(G.setSettings(state, { group: '' }));
    });
  },
  rImport: () =>
    tryRoster(() => {
      const n = roster.importUndercover($('#impTxt').value);
      $('#impTxt').value = '';
      toast(n ? `✅ ${n} joueur${n > 1 ? 's' : ''} importé${n > 1 ? 's' : ''} d’Undercover` : '✅ Groupes mis à jour (aucun nouveau joueur)');
    }),
};

function renderRoster() {
  const body = $('#rosterBody');
  if (!body) return;
  const list = roster.inGroup(rFilter);
  const count = (gid) => roster.inGroup(gid).length;
  const chips = [['', '👥 Tous']].concat(roster.groups.map((g) => [g.id, `${g.icon} ${esc(g.name)}`]))
    .map(([id, l]) => `<button class="chip ${rFilter === id ? 'on' : ''}" data-act="rFilter" data-g="${esc(id)}">${l} <small>${count(id)}</small></button>`)
    .join('');
  const groupsEditor = rGroupsOpen
    ? `<div class="gedit">${roster.groups
        .map((g) => `<div class="grow-row"><button class="mini big-ico" data-act="rgIcon" data-g="${esc(g.id)}" aria-label="Changer l’icône">${g.icon}</button>
          <input class="gname" data-gid="${esc(g.id)}" value="${esc(g.name)}" maxlength="20" aria-label="Nom du groupe">
          <span class="muted small">${count(g.id)}</span><button class="mini kick" data-act="rgDel" data-g="${esc(g.id)}" aria-label="Supprimer le groupe">✕</button></div>`)
        .join('')}
        <div class="row add-row"><input id="gNew" placeholder="Nouveau groupe (ex. Foot, Voisins)" maxlength="20" enterkeyhint="done"><button class="btn go" data-act="rgAdd">＋</button></div></div>`
    : '';
  const rows = list
    .map((p) => `<div class="rrow" style="--c:${esc(p.color)}">
      <button class="av" style="--c:${esc(p.color)}" data-act="rAvatar" data-id="${esc(p.id)}" aria-label="Changer l’animal">${esc(p.avatar)}</button>
      <input class="rname" data-rid="${esc(p.id)}" value="${esc(p.name)}" maxlength="16" aria-label="Prénom">
      <button class="dot" style="background:${esc(p.color)}" data-act="rColor" data-id="${esc(p.id)}" aria-label="Changer la couleur"></button>
      <button class="mini kick" data-act="rDel" data-id="${esc(p.id)}" aria-label="Supprimer">✕</button>
      <div class="gchips">${roster.groups.map((g) => `<button class="gchip ${p.groups.includes(g.id) ? 'on' : ''}" data-act="rToggle" data-id="${esc(p.id)}" data-g="${esc(g.id)}">${g.icon} ${esc(g.name)}</button>`).join('')}</div></div>`)
    .join('');
  body.innerHTML = `<h2>👥 Joueurs enregistrés</h2>
    <p class="muted small">Ils apparaissent dans le « Qui es-tu ? » des téléphones. Touche l’animal ou la pastille pour les changer, et les groupes pour y ranger un joueur.</p>
    <div class="chips">${chips}<button class="chip add" data-act="rGroups">⚙️ Groupes</button></div>
    ${groupsEditor}
    <div class="rlist">${rows || `<p class="muted center">${rFilter ? 'Personne dans ce groupe.' : 'Aucun joueur enregistré pour l’instant.'}</p>`}</div>
    <div class="row add-row"><input id="rNew" placeholder="Prénom du nouveau joueur" maxlength="16" enterkeyhint="done"><button class="btn go" data-act="rAdd">＋</button></div>
    <details class="imp"><summary>📥 Importer depuis Undercover</summary>
      <p class="muted small">Dans Undercover : « Exporter mes données », puis copie le code (il commence par UCF2:) ou télécharge le fichier. Les joueurs et les groupes sont ajoutés, rien n’est effacé.</p>
      <textarea id="impTxt" rows="3" placeholder="Colle le code ici (UCF2:…)"></textarea>
      <div class="row"><button class="btn" data-act="rImport">Importer le code</button><label class="btn ghost">📂 Fichier .json<input type="file" id="impFile" accept=".json,.txt,application/json,text/plain" hidden></label></div>
    </details>
    <button class="btn" data-act="close">Fermer</button>`;
}
$('#rosterBody').addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList.contains('rname')) {
    try {
      roster.update(t.dataset.rid, { name: t.value });
    } catch (err) {
      toast(err.message);
    }
    rosterChanged();
  } else if (t.classList.contains('gname')) {
    roster.renameGroup(t.dataset.gid, t.value);
    rosterChanged();
  } else if (t.id === 'impFile' && t.files[0]) {
    t.files[0].text().then((txt) => {
      $('#impTxt').value = txt;
      rosterActs.rImport();
    });
  }
});
$('#rosterBody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'rNew') rosterActs.rAdd();
  else if (e.target.id === 'gNew') rosterActs.rgAdd();
  else if (e.target.matches('.rname, .gname')) e.target.blur();
});

function groupPickerHtml() {
  const cur = state.settings.group;
  const opts = [['', '👥 Tous', roster.players.length]].concat(roster.groups.map((g) => [g.id, `${g.icon} ${esc(g.name)}`, roster.inGroup(g.id).length]));
  return `<div class="gpick"><span class="muted small">Groupe qui joue</span><div class="chips">${opts
    .map(([id, l, n]) => `<button class="chip ${cur === id ? 'on' : ''}" data-act="group" data-g="${esc(id)}">${l} <small>${n}</small></button>`)
    .join('')}<button class="chip add" data-act="roster">✏️ Joueurs</button></div></div>`;
}

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
        ${groupPickerHtml()}
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
let fixing = false; // mode « Corriger » du classement (boutons −1 / +1 / Exclure)
function render() {
  const q = state.q;
  // On ne reconstruit la zone principale que si elle change (évite de "manger" un appui).
  const stageKey = JSON.stringify([state.podium, q.n, q.phase, q.queue.map((e) => [e.id, e.res]), q.frozen, q.winner, q.locked.length, Object.keys(state.players).length, state.players[q.winner]?.score, connectedCount(), state.settings.group]);
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
  flipRender($('#board'), boardHtml(state, { online, host: fixing }));
  $('#board').classList.toggle('fixing', fixing);
  $('#fixBtn').textContent = fixing ? '✅ Terminé' : '✏️ Corriger';
  $('#fixBtn').hidden = !Object.keys(state.players).length;
  $('#fixHint').hidden = !fixing;
  $('#undoBtn').disabled = !undoStack.length;
  $('#endBtn').disabled = !hasPlayed() || state.podium;
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
