import type { Dossier, TraitName } from '../../core/protocol';

const TRAITS: { key: TraitName; label: string; low: string; high: string; colour: string }[] = [
  { key: 'hesitation', label: 'Hesitation', low: 'decisive', high: 'hesitant', colour: '#6e8cd6' },
  { key: 'curiosity', label: 'Curiosity', low: 'goal-driven', high: 'curious', colour: '#4fa36b' },
  { key: 'compliance', label: 'Compliance', low: 'defiant', high: 'compliant', colour: '#c98a3a' },
  { key: 'impulsivity', label: 'Impulsivity', low: 'careful', high: 'impulsive', colour: '#c55a5a' },
];

/** The ending: the player's personnel file, and behind a button, how every room was made. */
export function showDossier(root: HTMLElement, d: Dossier) {
  const v = d.verdict;
  const mins = Math.floor(d.seconds / 60), secs = d.seconds % 60;
  root.innerHTML = `
  <article class="file">
    <header>
      <div>
        <p class="kicker">Personnel file · subject ${d.seed}</p>
        <h1>${esc(v.name)}</h1>
      </div>
      <div class="stamp">File<br/>complete</div>
    </header>
    <p class="summary">${esc(v.summary)}</p>

    <section class="traits">
      ${TRAITS.map((t) => {
        const val = d.traits[t.key];
        const moments = d.moments[t.key];
        return `<div class="trait">
          <div class="trait-head"><strong>${t.label}</strong><span>${val >= 0.62 ? t.high : val <= 0.38 ? t.low : 'unremarkable'}</span></div>
          <div class="bar"><span style="left:${(val * 100).toFixed(0)}%;background:${t.colour}"></span><i></i></div>
          <div class="ends"><small>${t.low}</small><small>${t.high}</small></div>
          <p>${esc(v[t.key])}</p>
          ${moments.length ? `<ul>${moments.map((m) => `<li><b>${m.delta > 0 ? '+' : ''}${m.delta.toFixed(2)}</b> room ${m.room}: ${esc(m.reason)}</li>`).join('')}</ul>` : ''}
        </div>`;
      }).join('')}
    </section>

    <section class="path">
      <h2>Your path through the building</h2>
      <ol>${d.rooms.map((r) => `<li class="amb-${esc(r.ambience)}"><small>Room ${r.index}</small><strong>${esc(r.title)}</strong><span>${esc(r.archetype.replace('_', ' '))}${r.rule ? ` · ${esc(r.rule.replaceAll('_', ' '))}` : ''}</span></li>`).join('')}</ol>
    </section>

    ${d.tasks.length ? `<section class="tasks">
      <h2>What the building measured</h2>
      <ol>${d.tasks.map((t) => `<li>
        <small>Room ${t.room} · ${esc(t.title)}</small>
        ${t.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
        <dl>${Object.entries(t.metrics).filter(([, v]) => v !== null).map(([k, v]) => `<div><dt>${esc(k.replaceAll('_', ' '))}</dt><dd>${fmt(v!)}</dd></div>`).join('')}</dl>
      </li>`).join('')}</ol>
    </section>` : ''}

    ${d.threads.length ? `<section class="threads"><h2>Loose ends</h2><ul>${d.threads.map((t) => `<li>${esc(t.text)} <small>${t.resolvedIn !== undefined ? `opened in room ${t.room}, explained in room ${t.resolvedIn}` : `opened in room ${t.room}, never explained`}</small></li>`).join('')}</ul></section>` : ''}

    <p class="stats">${mins} min ${secs} s in the building · ${d.stats.inspected} things inspected · ${d.stats.pressed} button presses · ${d.stats.stoodStill} s standing still${d.stats.doorsTried ? ` · ${d.stats.doorsTried} locked doors tried` : ''}</p>
    <p class="closing">${esc(v.closing)}</p>

    <nav>
      <button id="d-built" type="button">How this world was built</button>
      <button id="d-replay" type="button">Replay this seed</button>
      <button id="d-again" type="button" class="primary">Play again</button>
    </nav>

    <section class="built" hidden>
      <h2>How this world was built</h2>
      <p class="note">No room existed before the player reached it. Seeded code laid out each room; ${d.rooms.filter((r) => r.source === 'model').length} of ${d.rooms.length} rooms were then written by the local model from what you had done so far (the rest used templates). The verdict above was written by ${d.verdictSource === 'model' ? 'the model' : 'templates'}.</p>
      ${d.tasks.length ? `<p class="note">Timing in the office tasks is compared with your own normal from the first room: walking speed ${fmt(d.baseline.speed)} m/s, ${fmt(d.baseline.inputRate)} key presses a second while walking, ${fmt(d.baseline.reaction)} s from a prompt to acting on it. A "z" metric is how many of your own usual spreads away from that normal you were.</p>` : ''}
      <h3>Your traits as you entered each room</h3>
      ${chart(d)}
      <h3>Room by room</h3>
      <table>
        <thead><tr><th>Room</th><th>Layout</th><th>Written by</th><th>Rule</th><th>What the model was told about you</th></tr></thead>
        <tbody>${d.rooms.map((r) => `<tr>
          <td><strong>${r.index}</strong> ${esc(r.title)}${r.fact ? `<small>${esc(r.fact)}</small>` : ''}</td>
          <td>${esc(r.archetype.replace('_', ' '))}<small>${esc(r.size)} · seed ${r.seed}</small></td>
          <td>${r.source}${r.genMs ? `<small>${(r.genMs / 1000).toFixed(1)} s</small>` : ''}</td>
          <td>${r.rule ? esc(r.rule.replaceAll('_', ' ')) : '·'}</td>
          <td>${r.behaviour.length || r.profile.length ? `<details><summary>${r.behaviour.length} notes</summary>${r.profile.length ? `<p><b>Profile:</b> ${r.profile.map(esc).join('; ')}</p>` : ''}${r.behaviour.map((b) => `<p>${esc(b)}</p>`).join('')}</details>` : '<small>first room, nothing yet</small>'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </section>
  </article>`;
  root.hidden = false;
  root.scrollTop = 0;

  const built = root.querySelector<HTMLElement>('.built')!;
  root.querySelector('#d-built')!.addEventListener('click', () => {
    built.hidden = !built.hidden;
    if (!built.hidden) built.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const go = (seed?: number) => {
    const p = new URLSearchParams(location.search);
    if (seed === undefined) p.delete('seed');
    else p.set('seed', String(seed));
    location.search = p.toString();
  };
  root.querySelector('#d-replay')!.addEventListener('click', () => go(d.seed));
  root.querySelector('#d-again')!.addEventListener('click', () => go());
}

/** Trait values across the rooms, plus the final value. */
function chart(d: Dossier): string {
  const points = [...d.rooms.map((r) => r.traitsAtEntry), d.traits];
  const W = 640, H = 180, L = 36, R = 16, T = 12, B = 28;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, points.length - 1);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const grid = [0, 0.5, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g${v === 0.5 ? ' mid' : ''}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const labels = points.map((_, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${i < d.rooms.length ? `room ${i}` : 'end'}</text>`).join('');
  const lines = TRAITS.map((t) => `<polyline fill="none" stroke="${t.colour}" stroke-width="2" points="${points.map((p, i) => `${x(i)},${y(p[t.key])}`).join(' ')}"/>`).join('');
  const legend = TRAITS.map((t) => `<span><i style="background:${t.colour}"></i>${t.label}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Trait scores across rooms">${grid}${labels}${lines}</svg><div class="legend">${legend}</div>`;
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function esc(s: string | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
