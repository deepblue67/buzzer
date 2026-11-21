// Rendu partagé : file des buzz, classement, podium.
import { esc } from './common.js';
import { ranking, awards, formatSeconds, headIndex, isHeadFrozen } from './game.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export function avatarBubble(p, size = '') {
  return `<span class="av ${size}" style="--c:${esc(p?.color || '#888')}">${esc(p?.avatar || '❔')}</span>`;
}

/** Remplace le contenu d'un conteneur en animant les éléments qui changent de place (FLIP). */
export function flipRender(container, html) {
  const before = new Map();
  for (const el of container.querySelectorAll('[data-key]')) before.set(el.dataset.key, el.getBoundingClientRect().top);
  container.innerHTML = html;
  for (const el of container.querySelectorAll('[data-key]')) {
    const old = before.get(el.dataset.key);
    if (old == null) {
      el.animate?.([{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'ease-out' });
      continue;
    }
    const dy = old - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  }
}

export function queueHtml(state, { me = null, empty = 'Personne n’a encore buzzé…' } = {}) {
  const q = state.q;
  if (!q.queue.length) return `<div class="empty">${empty}</div>`;
  const h = headIndex(q);
  const frozen = isHeadFrozen(q);
  return q.queue
    .map((e, i) => {
      const p = state.players[e.id] || { name: '(parti)', avatar: '👋', color: '#666' };
      let chip = '';
      let cls = '';
      if (e.res === 'right') {
        chip = '<span class="chip ok">✅ Bonne réponse</span>';
        cls = 'right';
      } else if (e.res === 'wrong') {
        chip = '<span class="chip ko">❌ Raté</span>';
        cls = 'wrong';
      } else if (i === h && q.phase === 'open') {
        chip = frozen ? '<span class="chip mic">🎤 Au micro</span>' : '<span class="chip wait">⏳ Vérif…</span>';
        cls = 'head';
      } else chip = '<span class="chip">En attente</span>';
      return `<li data-key="${esc(e.id)}" class="qrow ${cls} ${e.id === me ? 'me' : ''}" style="--c:${esc(p.color)}">
        <span class="pos">${i + 1}</span>${avatarBubble(p)}
        <span class="nm">${esc(p.name)}${e.id === me ? ' <em>(toi)</em>' : ''}</span>
        <span class="tm">${formatSeconds(e.rt)}</span>${chip}</li>`;
    })
    .join('');
}

export function boardHtml(state, { me = null, online = null, host = false } = {}) {
  const list = ranking(state);
  if (!list.length) return `<div class="empty">Aucun joueur pour l’instant. Scannez le QR code !</div>`;
  return list
    .map((p) => {
      const off = online && !online.has(p.id);
      const medal = p.score > 0 && p.rank <= 3 ? MEDALS[p.rank - 1] : `<span class="rk">${p.rank}</span>`;
      const streak = p.streak >= 2 ? `<span class="streak" title="Série en cours">🔥${p.streak}</span>` : '';
      const ctl = host
        ? `<span class="ctl"><button data-act="minus" data-id="${esc(p.id)}">−1 point</button><button data-act="plus" data-id="${esc(p.id)}">+1 point</button><button data-act="kick" data-id="${esc(p.id)}" class="kick">🚪 Exclure</button></span>`
        : '';
      return `<li data-key="${esc(p.id)}" class="brow ${p.id === me ? 'me' : ''} ${off ? 'off' : ''}" style="--c:${esc(p.color)}">
        <span class="medal">${medal}</span>${avatarBubble(p)}
        <span class="nm">${esc(p.name)}${p.id === me ? ' <em>(toi)</em>' : ''}${off ? ' <small>· déconnecté</small>' : ''}</span>
        ${streak}<span class="sc">${p.score}</span>${ctl}</li>`;
    })
    .join('');
}

export function podiumHtml(state) {
  const list = ranking(state);
  if (!list.some((p) => p.score > 0)) {
    return `<h2 class="ptitle">🏁 Fin de partie !</h2><p class="big-txt">🤷 Personne n’a marqué de point… revanche ?</p>`;
  }
  const top3 = [list[1], list[0], list[2]];
  const steps = top3
    .map((p, i) => {
      if (!p) return '<div class="step empty"></div>';
      const place = [2, 1, 3][i];
      return `<div class="step s${place}" style="--c:${esc(p.color)}">
        <div class="pav">${esc(p.avatar)}</div><div class="pname">${esc(p.name)}</div>
        <div class="block"><span>${MEDALS[Math.min(p.rank, 3) - 1]}</span><b>${p.score} pt${Math.abs(p.score) > 1 ? 's' : ''}</b></div></div>`;
    })
    .join('');
  const aw = awards(state)
    .map((a) => `<li style="--c:${esc(a.p.color)}"><span class="aicon">${a.icon}</span><span><b>${esc(a.title)}</b><br>${esc(a.p.avatar)} ${esc(a.p.name)} · ${esc(a.detail)}</span></li>`)
    .join('');
  return `<h2 class="ptitle">🏁 Fin de partie !</h2><div class="podium">${steps}</div>${aw ? `<ul class="awards">${aw}</ul>` : ''}`;
}

/** Texte du statut de la question, du point de vue d'un spectateur (TV / hôte). */
export function phaseLabel(state) {
  const q = state.q;
  switch (q.phase) {
    case 'lobby':
      return 'En attente des joueurs';
    case 'ready':
      return `Question ${q.n} · écoutez bien…`;
    case 'countdown':
      return `Question ${q.n} · attention…`;
    case 'open':
      return `Question ${q.n} · à vos buzzers !`;
    case 'resolved': {
      const w = q.winner && state.players[q.winner];
      return w ? `Question ${q.n} · ${w.avatar} ${w.name} marque le point !` : `Question ${q.n} · personne n’a trouvé`;
    }
  }
  return '';
}
