// Écran du salon : affichage seul (QR code, file des buzz, classement, podium).
import { createTransport } from './transport.js';
import { ClockSync } from './clock.js';
import * as G from './game.js';
import { now, getRoom, link, absUrl, esc, $, keepAwake, setConn, qrSvg } from './common.js';
import { queueHtml, boardHtml, podiumHtml, phaseLabel, avatarBubble, flipRender } from './ui.js';
import * as FX from './fx.js';

const room = getRoom();
if (!room) {
  // Pas de code dans l'adresse : on le demande.
  $('#askCode').hidden = false;
  $('#start').remove();
  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = $('#askForm').code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (c.length === 4) location.href = link('tv.html', { r: c });
  });
  await new Promise(() => {});
}

const key = 'tv-' + G.randomId(6);
const joinUrl = absUrl('play.html', { r: room });
let state = null;
let online = new Set();
let lastSpot = '';

$('#qrMini').innerHTML = qrSvg(joinUrl);
$('#qrBig').innerHTML = qrSvg(joinUrl);
$('#code').textContent = room;
$('#codeMini').textContent = room;
$('#joinUrl').textContent = joinUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '') ;

const tr = createTransport(room, {
  key,
  meta: { role: 'tv' },
  onStatus: (s) => {
    setConn(s, tr.local);
    if (s === 'online') tr.send('hello', { role: 'tv', id: key });
  },
});
const clock = new ClockSync({ id: key, now, send: (ev, p) => tr.send(ev, p) });
clock.start();
tr.on('pong', (m) => clock.handlePong(m));
tr.on('resync', () => clock.burst(5));

tr.on('state', ({ state: s }) => {
  if (state && s.gid === state.gid && s.v <= state.v) return;
  const prev = state;
  state = s;
  react(prev);
  render();
});

tr.on('fx', ({ kind, id, party }) => {
  if (!state) return;
  const p = id && state.players[id];
  if (kind === 'right') {
    FX.play('right');
    FX.confetti({ colors: [p?.color || '#ffd60a', '#ffd60a', '#ffffff', '#2ec4b6'], count: 220 });
  } else if (kind === 'wrong') {
    FX.play('wrong');
    FX.shake($('#spot'));
  } else if (kind === 'open') FX.play('go');
  else if (kind === 'join') FX.play('join');
  else if (kind === 'podium' && party) {
    FX.play('fanfare');
    FX.confetti({ count: 300 });
  }
});

tr.onPresence((list) => {
  online = new Set(list.filter((m) => m.role === 'player').map((m) => m.id));
  render();
});

/** Réactions visuelles/sonores déduites des changements d'état. */
function react(prev) {
  if (!prev) return;
  const q = state.q;
  // Premier buzz de la question : flash + son du joueur
  if (prev.q.n === q.n && prev.q.queue.length === 0 && q.queue.length > 0) {
    const p = state.players[q.queue[0].id];
    if (p) {
      FX.play(p.sound);
      FX.flash(p.color);
    }
  }
}

function spotHtml() {
  const q = state.q;
  switch (q.phase) {
    case 'lobby': {
      const ps = Object.values(state.players);
      return `<div class="tv-lobby">
        <div class="qrbox">${$('#qrBig').innerHTML}</div>
        <div class="tv-join"><p>Rejoignez la partie !</p><p class="muted">Scannez le QR code<br>ou allez sur <b>${esc($('#joinUrl').textContent)}</b></p><p>Code <b class="code">${room}</b></p></div></div>
        <div class="crowd">${ps.map((p) => `<span class="bounce" style="--c:${esc(p.color)}">${avatarBubble(p, 'lg')}<small>${esc(p.name)}</small></span>`).join('') || '<span class="muted">En attente des joueurs…</span>'}</div>`;
    }
    case 'ready':
      return `<div class="tv-big">👂</div><div class="tv-msg">Écoutez bien la question…</div>`;
    case 'countdown':
      return `<div class="countdown tv" id="cd">3</div>`;
    case 'open': {
      const h = G.headIndex(q);
      if (h < 0) return `<div class="tv-big pulse">🔔</div><div class="tv-msg">À vos buzzers !</div><div class="timer" id="timer">0,0 s</div>`;
      const e = q.queue[h];
      const p = state.players[e.id] || { name: '?', avatar: '❔', color: '#888' };
      return `<div class="tv-who" style="--c:${esc(p.color)}">${avatarBubble(p, 'xxl')}<div class="tv-name">${esc(p.name)}</div>
        <div class="tv-time">🔔 ${G.formatSeconds(e.rt)}</div>
        <div class="tv-msg small">${G.isHeadFrozen(q) ? '🎤 Au micro !' : '⏳ Vérification de l’ordre…'}</div></div>`;
    }
    case 'resolved': {
      const w = q.winner && state.players[q.winner];
      return w
        ? `<div class="tv-who win" style="--c:${esc(w.color)}">${avatarBubble(w, 'xxl')}<div class="tv-name">${esc(w.name)}</div><div class="tv-time">+1 point 🎉</div></div>`
        : `<div class="tv-big">🤷</div><div class="tv-msg">Personne n’a trouvé !</div>`;
    }
  }
  return '';
}

function render() {
  if (!state) return;
  const q = state.q;
  document.body.dataset.phase = state.podium ? 'podium' : q.phase;
  $('#phase').textContent = phaseLabel(state);
  const spotKey = JSON.stringify([q.n, q.phase, G.headIndex(q), q.queue[G.headIndex(q)]?.id, G.isHeadFrozen(q), q.winner, q.phase === 'lobby' ? Object.values(state.players).map((p) => p.id + p.avatar + p.name) : 0]);
  if (spotKey !== lastSpot) {
    $('#spot').innerHTML = spotHtml();
    lastSpot = spotKey;
  }
  $('#queueWrap').hidden = !(q.phase === 'open' || q.phase === 'resolved') || !q.queue.length;
  flipRender($('#queue'), queueHtml(state));
  flipRender($('#board'), boardHtml(state, { online }));
  const pod = $('#podium');
  pod.classList.toggle('open', !!state.podium);
  if (state.podium && pod.dataset.v !== String(state.v)) {
    pod.querySelector('.inner').innerHTML = podiumHtml(state);
    pod.dataset.v = state.v;
  }
}

setInterval(() => {
  if (!state) return;
  const q = state.q;
  const t = $('#timer');
  if (t && q.phase === 'open' && q.openedAt) t.textContent = ((clock.hostNow() - q.openedAt) / 1000).toFixed(1).replace('.', ',') + ' s';
  const cd = $('#cd');
  if (cd && q.phase === 'countdown') {
    const left = String(Math.max(1, Math.ceil((q.openAt - clock.hostNow()) / 1000)));
    if (cd.textContent !== left) {
      cd.textContent = left;
      FX.play('tick');
    }
  }
}, 100);

// Les navigateurs exigent un clic avant de jouer du son.
$('#start').addEventListener('click', () => {
  FX.unlockAudio();
  FX.play('join');
  $('#start').remove();
  document.documentElement.requestFullscreen?.().catch(() => {});
});

keepAwake();
