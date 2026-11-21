// Synchronisation d'horloge façon NTP entre un joueur et le maître du jeu.
// Le téléphone du maître du jeu sert d'horloge de référence ("heure hôte").
// Ce module est pur (pas de DOM) : il est testé dans tests/.

/** Horloge locale haute précision, en millisecondes "epoch". */
export function localNow() {
  if (typeof performance !== 'undefined' && performance.timeOrigin) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

/**
 * Calcule un échantillon à partir d'un aller-retour.
 * t0 : envoi du ping (horloge joueur), th : réception par l'hôte (horloge hôte),
 * t1 : réception du pong (horloge joueur).
 */
export function makeSample(t0, th, t1) {
  const rtt = Math.max(0, t1 - t0);
  return { rtt, offset: th - (t0 + t1) / 2, at: t1 };
}

/**
 * Estime le décalage à partir d'échantillons : les allers-retours les plus
 * rapides sont les plus fiables (moins de file d'attente, moins d'asymétrie).
 * On prend la médiane des décalages des 3 meilleurs échantillons récents.
 */
export function estimate(samples, { maxAgeMs = 180000, now = null } = {}) {
  if (!samples.length) return null;
  const ref = now ?? samples[samples.length - 1].at;
  let pool = samples.filter((s) => ref - s.at <= maxAgeMs);
  if (pool.length < 3) pool = samples.slice(-8);
  const best = [...pool].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
  const offs = best.map((s) => s.offset).sort((a, b) => a - b);
  const offset = offs[Math.floor(offs.length / 2)];
  return { offset, rtt: best[0].rtt, n: samples.length };
}

/**
 * Client de synchro côté joueur / TV.
 * send(event, payload) : envoie un message ; on reçoit les pongs via handlePong().
 */
export class ClockSync {
  constructor({ id, send, now = localNow, burst = 8, gap = 130, period = 20000, onChange = null }) {
    Object.assign(this, { id, send, now, burstSize: burst, gap, period, onChange });
    this.samples = [];
    this.pending = new Map();
    this.n = 0;
    this.offset = 0;
    this.rtt = null;
    this.ready = false;
    this._timers = [];
  }

  start() {
    this.burst(this.burstSize);
    this._interval = setInterval(() => this.burst(3), this.period);
  }

  stop() {
    clearInterval(this._interval);
    this._timers.forEach(clearTimeout);
  }

  burst(count) {
    for (let i = 0; i < count; i++) {
      this._timers.push(setTimeout(() => this.ping(), i * this.gap));
    }
  }

  ping() {
    const n = ++this.n;
    const t0 = this.now();
    this.pending.set(n, t0);
    if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value);
    this.send('ping', { id: this.id, n, t0 });
  }

  handlePong({ to, n, t0, th }) {
    if (to !== this.id || !this.pending.has(n)) return;
    this.pending.delete(n);
    const t1 = this.now();
    this.samples.push(makeSample(t0, th, t1));
    if (this.samples.length > 40) this.samples.shift();
    const est = estimate(this.samples, { now: t1 });
    const wasReady = this.ready;
    this.offset = est.offset;
    this.rtt = est.rtt;
    this.ready = true;
    if (this.onChange) this.onChange({ offset: this.offset, rtt: this.rtt, first: !wasReady });
  }

  /** Heure actuelle convertie en heure hôte. */
  hostNow() {
    return this.now() + this.offset;
  }

  /** Convertit un instant local en heure hôte. */
  toHost(tLocal) {
    return tLocal + this.offset;
  }
}
