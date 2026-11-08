import type { AlsoMeasured, Dossier, Measured, SelfTrait, TraitName } from '../../core/protocol';

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
  // Traits caught pointing opposite ways are shown as one pattern, not two labels.
  const patterns = d.patterns ?? [];
  const mixed = new Set(patterns.flatMap((p) => p.traits));
  const name = (k: TraitName) => TRAITS.find((t) => t.key === k)!.label;
  root.innerHTML = `
  <article class="file">
    ${saidDid(d)}
    <header>
      <div>
        <p class="kicker">Personnel file · subject ${d.seed}</p>
        <h1>${esc(v.name)}</h1>
      </div>
      <div class="stamp">File<br/>complete</div>
    </header>
    <p class="summary">${esc(v.summary)}</p>

    ${patterns.map((p) => `<div class="pattern"><small>${name(p.traits[0])} and ${name(p.traits[1]).toLowerCase()}, both high</small><p>${esc(p.sentence)}</p></div>`).join('')}
    <section class="traits">
      ${TRAITS.map((t) => {
        const val = d.traits[t.key];
        const moments = d.moments[t.key];
        return `<div class="trait">
          <div class="trait-head"><strong>${t.label}</strong><span>${mixed.has(t.key) ? 'see pattern above' : val >= 0.62 ? t.high : val <= 0.38 ? t.low : 'unremarkable'}</span></div>
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

    ${d.gambles?.length ? `<section class="gambles"><h2>Your gambles</h2><ul>${d.gambles.map((g) => `<li><small>Room ${g.room}${g.timed ? ' · on the clock' : ''}</small>${g.choice === 'risky' ? `Took the 50/50 door: <b>${g.outcome === 'shortcut' ? 'shortcut' : 'detour'}</b>` : g.expired ? 'Let the clock run out: certain door' : 'Took the certain door'}</li>`).join('')}</ul></section>` : ''}

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
      <p class="note">No room existed before the player reached it. Seeded code laid out each room; ${d.rooms.filter((r) => r.source === 'model').length} of ${d.rooms.length} rooms were then written by the local model from what you had done so far (the rest used templates). The verdict above was written by ${d.verdictSource === 'model' ? 'the model' : 'templates'}${d.verdictConflicts?.length ? `; its title and summary contradicted what you did (${d.verdictConflicts.join(', ')}), so they were rewritten from your measured scores` : ''}.</p>
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

const SELF: { key: SelfTrait; label: string }[] = [
  { key: 'risk', label: 'I take risks' },
  { key: 'patience', label: 'I am patient' },
  { key: 'social', label: "I do what I'm told" },
  { key: 'exploration', label: 'I explore everything' },
];

/**
 * The top of the file: the biggest gap between what the player said about
 * themselves and what they did, in large type, then each trait side by side.
 */
function saidDid(d: Dossier): string {
  const sd = d.saidDid;
  if (!d.measured) return '';
  const dots = (n: number | null, cls: string) => `<span class="dots ${cls}" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${n !== null && i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  const row = (key: SelfTrait, label: string, m: Measured) => {
    const r = sd?.rows.find((x) => x.trait === key);
    const said = r?.said ?? null;
    // Untested this run: no score to compare, never a red gap, never the headline.
    const did = m.estimated ? null : Math.round(m.score);
    // A single yes/no moment is shown, but never highlighted as a gap.
    const gap = said === null || did === null || m.oneObservation ? 0 : Math.abs(said - did);
    // Task evidence (only once tasks have reported), minus the line already shown as the main evidence.
    const lines = (m.tasks ?? []).map((x) => x.evidence).filter((x) => x !== m.evidence);
    return `<div class="sd-row${sd?.headlineTrait === key ? ' top' : ''}${gap >= 2 ? ' gap' : ''}${did === null ? ' untested' : ''}">
      <strong>${esc(label)}</strong>
      <div class="sd-vals">
        ${sd ? `<span>You said: <b>${said === null ? '–' : `${said}/5`}</b>${dots(said, 'said')}</span>` : ''}
        ${did === null
          ? `<span class="nt">You did: <b>not tested this run</b> <em>(estimate ${Math.round(m.score)}/5)</em></span>`
          : `<span>You did: <b>${did}/5</b>${dots(did, 'did')}${m.oneObservation ? ' <em>(one observation)</em>' : ''}</span>`}
      </div>
      <p>${esc(m.evidence)}</p>
      ${lines.length ? `<ul class="sd-tasks">${lines.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`;
  };
  return `<section class="saiddid">
    <p class="kicker">${sd ? 'You said · you did' : 'What you did'}</p>
    ${sd ? `<h2 class="headline${sd.headlineTrait ? '' : ' calm'}">${esc(sd.headline)}</h2><p class="detail">${esc(sd.detail)}</p>` : ''}
    <div class="sd-rows">${SELF.map((t) => row(t.key, t.label, d.measured[t.key])).join('')}</div>
    ${alsoMeasured(d.alsoMeasured)}
  </section>`;
}

/** Traits with no slider, measured by the office tasks. Absent until a task has reported. */
function alsoMeasured(list: AlsoMeasured[] | undefined): string {
  if (!list?.length) return '';
  return `<div class="also">
    <p class="kicker">Also measured</p>
    <div class="sd-rows">${list.map((a) => `<div class="sd-row">
      <strong>${esc(a.label)}</strong>
      <div class="sd-vals"><span>Measured: <b>${Math.round(a.score)}/5</b>${a.oneObservation ? ' <em>(one observation)</em>' : ''}</span></div>
      ${a.evidence.length === 1 ? `<p>${esc(a.evidence[0])}</p>` : `<ul class="sd-tasks">${a.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`}
    </div>`).join('')}</div>
  </div>`;
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

function esc(s: string | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
