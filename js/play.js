// Téléphone joueur : le buzzer.
import { createTransport } from './transport.js';
import { ClockSync } from './clock.js';
import * as G from './game.js';
import { now, getRoom, link, esc, $, $$, toast, keepAwake, setConn, deviceId, profileStore, AVATARS, COLORS, SOUNDS } from './common.js';
import { queueHtml, boardHtml, podiumHtml, flipRender } from './ui.js';
import * as FX from './fx.js';

const room = getRoom();
if (!room) {
  location.replace(link('index.html'));
  await new Promise(() => {}); // stoppe le module pendant la redirection
}
const me = deviceId();
let profile = profileStore.get();
let state = null;
let online = false;
let hostOnline = null;
let hostSeenAt = 0;
let myBuzz = null; // { qn, t, sentAt } : buzz envoyé, pas encore confirmé
let falseStartUntil = 0;
let tab = 'board';
let tabAuto = true;
let lastPhaseKey = '';
let lastHello = 0;
const startedAt = Date.now();

$('#roomCode').textContent = room;

const tr = createTransport(room, {
  key: 'p-' + me,
  meta: { role: 'player', id: me },
  onStatus: (s) => {
    online = s === 'online';
    setConn(s, tr.local);
    if (online) {
      tr.send('need-state', {});
      sayHello(true);
    }
  },
});

const clock = new ClockSync({
  id: me,
  now,
  send: (ev, p) => tr.send(ev, p),
  onChange: ({ first }) => {
    if (first) sayHello(true);
  },
});
clock.start();

function sayHello(force = false) {
  if (!profile || !online) return;
  if (!force && Date.now() - lastHello < 2500) return;
  lastHello = Date.now();
  tr.send('hello', { ...profile, id: me, role: 'player', rtt: clock.rtt ?? undefined });
}

// ---------- Messages ----------
tr.on('pong', (m) => clock.handlePong(m));
tr.on('resync', () => clock.burst(5));

let pick = []; // joueurs enregistrés proposés par le maître du jeu (« Qui es-tu ? »)
let onlineIds = new Set();
tr.on('state', ({ state: s, pick: pk }) => {
  if (Array.isArray(pk) && JSON.stringify(pk) !== JSON.stringify(pick)) {
    pick = pk;
    renderWho();
  }
  if (state && s.gid === state.gid && s.v <= state.v) return;
  const prev = state;
  state = s;
  hostSeenAt = Date.now();
  onStateChange(prev);
  renderWho();
  render();
});

// Prénom refusé par le maître du jeu (déjà pris par un joueur connecté)
tr.on('join-err', ({ to, msg }) => {
  if (to !== me) return;
  toast(msg, 3500);
  FX.play('nope');
  draft = { ...draft, ...(profile || {}), rid: null };
  profile = null;
  renderJoin();
  $('#join').classList.add('open');
  render();
});

tr.on('fx', ({ kind, id, party }) => {
  if (kind === 'open') {
    FX.play('go');
    FX.vibrate(40);
  } else if (kind === 'right') {
    if (id === me) {
      FX.play('right');
      FX.vibrate([60, 60, 60, 60, 200]);
      FX.confetti({ colors: [profile?.color || '#ffd60a', '#ffd60a', '#ffffff', '#2ec4b6'] });
    } else FX.play('blip');
  } else if (kind === 'wrong') {
    if (id === me) {
      FX.play('wrong');
      FX.vibrate([300, 80, 300]);
      FX.shake($('#buzzer'));
    } else FX.play('nope');
  } else if (kind === 'podium' && party) {
    FX.play('fanfare');
    FX.confetti({ count: 220 });
  }
});

tr.onPresence((list) => {
  onlineIds = new Set(list.filter((m) => m.role === 'player').map((m) => m.id));
  renderWho();
  const h = list.some((m) => m.role === 'host');
  if (h) hostSeenAt = Date.now();
  hostOnline = h;
  render();
});

function onStateChange(prev) {
  const q = state.q;
  // Pas encore inscrit (ou partie relancée) : on se (ré)annonce.
  if (profile && !state.players[me] && !state.kicked.includes(me)) sayHello();
  // Mon buzz est confirmé (ou la question a changé) : on oublie le buzz en attente.
  if (myBuzz && (myBuzz.qn !== q.n || q.queue.some((e) => e.id === me) || q.phase !== 'open')) myBuzz = null;
  // Un autre joueur vient de prendre la main : petit signal.
  if (prev && prev.q.n === q.n && prev.q.queue.length === 0 && q.queue.length > 0 && q.queue[0].id !== me) {
    FX.vibrate(25);
  }
  // Changement d'onglet automatique
  const key = q.n + ':' + q.phase + ':' + (q.queue.length > 0);
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    if (tabAuto) tab = q.phase === 'open' && q.queue.length ? 'queue' : q.phase === 'open' ? tab : 'board';
  }
}

// Renvoi du buzz s'il n'a pas été confirmé (message perdu, réseau capricieux).
setInterval(() => {
  if (!myBuzz || !state) return;
  if (Date.now() - myBuzz.sentAt > 1200 && state.q.n === myBuzz.qn && state.q.phase === 'open') {
    myBuzz.sentAt = Date.now();
    tr.send('buzz', { id: me, t: myBuzz.t, rtt: clock.rtt, qn: myBuzz.qn });
  }
}, 400);

// ---------- Le buzzer ----------
function eventTime(e) {
  // L'horodatage de l'événement tactile est plus précis que l'heure de traitement.
  const pn = performance.now();
  if (e && e.timeStamp > 0 && e.timeStamp <= pn + 1 && pn - e.timeStamp < 1000) return now() - (pn - e.timeStamp);
  return now();
}

function press(e) {
  const tLocal = eventTime(e);
  e?.preventDefault?.();
  FX.unlockAudio();
  if (!state || !state.players[me]) return;
  const q = state.q;
  const btn = $('#buzzer');
  btn.classList.remove('pressed');
  void btn.offsetWidth;
  btn.classList.add('pressed');

  if (Date.now() < falseStartUntil) {
    FX.play('nope');
    return;
  }
  const inQueue = q.queue.some((e) => e.id === me) || (myBuzz && myBuzz.qn === q.n);
  const locked = q.locked.includes(me);
  if (q.phase === 'open' && !inQueue && !locked) {
    const t = clock.ready ? clock.toHost(tLocal) : null;
    myBuzz = { qn: q.n, t, sentAt: Date.now() };
    tr.send('buzz', { id: me, t, rtt: clock.rtt, qn: q.n });
    FX.play(profile.sound);
    FX.vibrate(70);
    FX.flash(profile.color);
    render();
    return;
  }
  if ((q.phase === 'ready' || q.phase === 'countdown') && state.settings.falseStart) {
    falseStartUntil = Date.now() + 1000;
    FX.play('nope');
    FX.vibrate([30, 40, 30]);
    FX.shake(btn);
    render();
    setTimeout(render, 1050);
    return;
  }
  FX.play('nope');
  FX.shake(btn);
}

$('#buzzer').addEventListener('pointerdown', press);
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat && !e.target.matches('input, textarea, select, button')) press(e);
});

// ---------- Onglets ----------
$$('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    tabAuto = false;
    setTimeout(() => (tabAuto = true), 15000);
    render();
  })
);

// ---------- Rendu ----------
function statusFor() {
  const q = state.q;
  const p = state.players[me];
  if (!p) return { title: 'Inscription…', sub: 'Connexion au maître du jeu', btn: 'closed', label: '…' };
  if (Date.now() < falseStartUntil) return { title: 'Trop tôt ! 🐢', sub: 'Buzzer bloqué une seconde', btn: 'early', label: '🐢' };
  switch (q.phase) {
    case 'lobby':
      return { title: 'Tu es inscrit·e ! 🎉', sub: 'La partie va bientôt commencer', btn: 'closed', label: 'BUZZ' };
    case 'ready':
      return { title: 'Écoute la question… 👂', sub: 'Attends le TOP du maître du jeu', btn: 'closed', label: 'BUZZ' };
    case 'countdown': {
      const left = Math.max(1, Math.ceil((q.openAt - clock.hostNow()) / 1000));
      return { title: 'Attention…', sub: state.settings.falseStart ? 'Pas avant le top, sinon 🐢 !' : 'Prépare ton doigt', btn: 'closed count', label: String(left) };
    }
    case 'open': {
      if (q.locked.includes(me)) return { title: 'Raté 😬', sub: 'Tu ne peux plus buzzer sur cette question', btn: 'locked', label: '❌' };
      const idx = q.queue.findIndex((e) => e.id === me);
      if (idx >= 0) {
        const h = G.headIndex(q);
        const e = q.queue[idx];
        if (idx === h) {
          return G.isHeadFrozen(q)
            ? { title: 'À toi ! 🎤', sub: `Réponds à voix haute · buzz en ${G.formatSeconds(e.rt)}`, btn: 'mine', label: '🎤' }
            : { title: 'Tu es 1er·e ! ⏳', sub: 'On vérifie l’ordre des buzz…', btn: 'queued', label: '1' };
        }
        const ahead = q.queue.slice(0, idx).filter((x) => !x.res).length;
        return { title: `Tu es ${ahead + 1}e 🤞`, sub: `${ahead} joueur${ahead > 1 ? 's' : ''} avant toi · buzz en ${G.formatSeconds(e.rt)}`, btn: 'queued', label: `${ahead + 1}e` };
      }
      if (myBuzz && myBuzz.qn === q.n) return { title: 'Buzz envoyé ! 🚀', sub: 'Calcul du classement…', btn: 'queued', label: '🚀' };
      const h = G.headIndex(q);
      if (h >= 0) {
        const hp = state.players[q.queue[h].id];
        return { title: 'Tu peux encore buzzer !', sub: `${hp ? hp.avatar + ' ' + hp.name : 'Quelqu’un'} répond en ce moment`, btn: 'open', label: 'BUZZ' };
      }
      return { title: 'BUZZE ! 🔔', sub: 'Le plus rapide qui sait gagne', btn: 'open', label: 'BUZZ' };
    }
    case 'resolved': {
      const w = q.winner && state.players[q.winner];
      if (w && w.id === me) return { title: 'Bravo ! +1 point 🎉', sub: 'Prochaine question dans un instant', btn: 'won', label: '🏆' };
      if (w) return { title: `${w.avatar} ${w.name} a trouvé !`, sub: 'Prochaine question dans un instant', btn: 'closed', label: 'BUZZ' };
      return { title: 'Personne n’a trouvé 🤷', sub: 'Prochaine question dans un instant', btn: 'closed', label: 'BUZZ' };
    }
  }
  return { title: '', sub: '', btn: 'closed', label: 'BUZZ' };
}

function render() {
  const joinOpen = !profile || $('#join').classList.contains('open');
  document.body.classList.toggle('joining', joinOpen);
  if (!state) {
    $('#title').textContent = 'Connexion…';
    $('#sub').textContent = Date.now() - startedAt > 4000 ? `En attente du maître du jeu (salle ${room})` : 'Recherche de la partie';
    return;
  }
  const kicked = state.kicked.includes(me) && !state.players[me];
  $('#kicked').hidden = !kicked;
  const p = state.players[me];
  if (p) {
    const r = G.ranking(state).find((x) => x.id === me);
    $('#meAv').textContent = p.avatar;
    $('#meAv').style.setProperty('--c', p.color);
    $('#meName').textContent = p.name;
    $('#meScore').textContent = p.score;
    $('#meRank').textContent = r ? (r.rank === 1 ? '1er' : r.rank + 'e') : '';
  }
  const st = statusFor();
  $('#title').textContent = st.title;
  $('#sub').textContent = st.sub;
  const btn = $('#buzzer');
  btn.className = 'buzzer ' + st.btn;
  btn.style.setProperty('--c', profile?.color || '#ff4d6d');
  $('#buzzLabel').textContent = st.label;
  $('#hostOff').hidden = hostOnline !== false || Date.now() - hostSeenAt < 4000;

  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const n = state.q.queue.length;
  $('#tabQueue').textContent = n ? `File (${n})` : 'File';
  $('#queue').hidden = tab !== 'queue';
  $('#board').hidden = tab !== 'board';
  if (tab === 'queue') flipRender($('#queue'), queueHtml(state, { me, empty: state.q.phase === 'open' ? 'Personne n’a encore buzzé… fonce !' : 'La file apparaîtra ici.' }));
  else flipRender($('#board'), boardHtml(state, { me }));

  const pod = $('#podium');
  pod.classList.toggle('open', !!state.podium);
  if (state.podium && pod.dataset.v !== String(state.v)) {
    pod.querySelector('.inner').innerHTML = podiumHtml(state);
    pod.dataset.v = state.v;
  }
}
setInterval(() => state && (state.q.phase === 'countdown' || falseStartUntil) && render(), 150);
setInterval(() => !state && render(), 1000);

// ---------- Inscription ----------
const form = $('#joinForm');
let draft = {
  name: profile?.name || '',
  avatar: profile?.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)],
  color: profile?.color || COLORS[Math.floor(Math.random() * COLORS.length)],
  sound: profile?.sound || SOUNDS[Math.floor(Math.random() * SOUNDS.length)].id,
  rid: profile?.rid || null, // joueur enregistré choisi dans « Qui es-tu ? »
};
const sameName = (a, b) => String(a).trim().toLocaleLowerCase('fr') === String(b).trim().toLocaleLowerCase('fr');
/** Prénom déjà utilisé par un autre joueur connecté ? */
function takenBy(name) {
  if (!state) return null;
  return Object.values(state.players).find((p) => p.id !== me && onlineIds.has(p.id) && sameName(p.name, name)) || null;
}

/** « Qui es-tu ? » : joueurs enregistrés du groupe qui joue, sauf ceux déjà connectés. */
function renderWho() {
  const box = $('#who');
  if (!box) return;
  const list = pick.filter((p) => !takenBy(p.name));
  box.hidden = !list.length;
  $('#whoList').innerHTML = list
    .map((p) => `<button type="button" class="who-chip ${draft.rid === p.id ? 'on' : ''}" data-rid="${esc(p.id)}" style="--c:${esc(p.color)}"><span class="av" style="--c:${esc(p.color)}">${esc(p.avatar)}</span>${esc(p.name)}</button>`)
    .join('');
  $('#nameLbl').firstChild.textContent = list.length ? 'Ou écris ton prénom' : 'Prénom';
}

function renderJoin() {
  form.name.value = draft.name;
  renderWho();
  $('#avatars').innerHTML = AVATARS.map((a) => `<button type="button" class="pick ${a === draft.avatar ? 'on' : ''}" data-av="${a}">${a}</button>`).join('');
  $('#colors').innerHTML = COLORS.map((c) => `<button type="button" class="swatch ${c === draft.color ? 'on' : ''}" data-color="${c}" style="--c:${c}" aria-label="Couleur ${c}"></button>`).join('');
  $('#sounds').innerHTML = SOUNDS.map((s) => `<button type="button" class="pick wide ${s.id === draft.sound ? 'on' : ''}" data-sound="${s.id}">${s.label}</button>`).join('');
  $('#preview').style.setProperty('--c', draft.color);
  $('#preview').textContent = draft.avatar;
}
form.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  FX.unlockAudio();
  if (b.dataset.rid) {
    const p = pick.find((x) => x.id === b.dataset.rid);
    if (p) draft = { ...draft, name: p.name, avatar: p.avatar, color: p.color, rid: p.id };
    renderJoin();
    return;
  }
  if (b.dataset.av) draft.avatar = b.dataset.av;
  if (b.dataset.color) draft.color = b.dataset.color;
  if (b.dataset.sound) {
    draft.sound = b.dataset.sound;
    FX.play(draft.sound);
  }
  draft.name = form.name.value;
  renderJoin();
});
form.name.addEventListener('input', () => {
  draft.name = form.name.value;
  const p = draft.rid && pick.find((x) => x.id === draft.rid);
  if (draft.rid && (!p || !sameName(p.name, draft.name))) {
    draft.rid = null;
    renderWho();
  }
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  FX.unlockAudio();
  const name = form.name.value.trim();
  if (!name) {
    form.name.focus();
    toast('Ton prénom d’abord 😉');
    return;
  }
  const other = takenBy(name);
  if (other) {
    toast(`${other.name} est déjà dans la partie 🙂 Choisis un autre prénom.`, 3500);
    return;
  }
  const rp = draft.rid && pick.find((x) => x.id === draft.rid);
  profile = { ...draft, name: name.slice(0, 16), rid: rp && sameName(rp.name, name) ? rp.id : null };
  profileStore.set(profile);
  $('#join').classList.remove('open');
  FX.play('join');
  sayHello(true);
  render();
});
$('#editProfile').addEventListener('click', () => {
  draft = { ...profile };
  renderJoin();
  $('#join').classList.add('open');
  render();
});
$('#rejoin').addEventListener('click', () => {
  tr.send('hello', { ...profile, id: me, role: 'player', rtt: clock.rtt ?? undefined, rejoin: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    clock.burst(5);
    tr.send('need-state', {});
  }
});

renderJoin();
if (!profile) $('#join').classList.add('open');
render();
keepAwake();
