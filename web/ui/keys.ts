import { DEFAULTS, forgetKeys, loadKeys, saveKeys, type PlayerKeys, type RoomsBackend, type RoomsSource, type VoiceSettings } from '../settings/keys';

/**
 * "Use your own AI keys" on the start screen. The game plays fully without
 * keys (template rooms, subtitles only); with them, the rooms are written live
 * and the narrator speaks. Keys are kept in this browser only
 * (web/settings/keys.ts) and the page reloads to apply them.
 */
export function mountKeysPanel(root: HTMLDetailsElement, now: { rooms?: RoomsSource; voice: VoiceSettings }): HTMLDetailsElement {
  const keys = loadKeys();
  const using = [keys.rooms !== 'off' && 'rooms', keys.elevenlabsKey && 'voice'].filter(Boolean);
  root.innerHTML = `
    <summary>Use your own AI keys <span>${using.length ? `in use: ${using.join(' and ')}` : 'optional'}</span></summary>
    <div class="keys-body">
      <p class="keys-note">The game plays fully without keys: rooms are then written from templates and the narrator is subtitles only.
        Keys are saved in this browser only and sent only to the service they belong to.</p>
      <fieldset>
        <legend>Rooms</legend>
        <label class="row">Written by
          <select name="rooms">
            <option value="off">Templates (no key)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama on this computer</option>
            <option value="lmstudio">LM Studio on this computer</option>
          </select>
        </label>
        <div class="group" data-for="openrouter">
          <label class="row">API key <input name="openrouterKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-…" /></label>
          <label class="row">Model <input name="openrouterModel" autocomplete="off" spellcheck="false" placeholder="${DEFAULTS.openrouterModel}" /></label>
          <small>Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. The model must support structured outputs (JSON schema); the default does.</small>
        </div>
        <div class="group" data-for="ollama">
          <label class="row">Address <input name="ollamaUrl" autocomplete="off" spellcheck="false" placeholder="${DEFAULTS.ollamaUrl}" /></label>
          <label class="row">Model <input name="ollamaModel" autocomplete="off" spellcheck="false" placeholder="${DEFAULTS.ollamaModel}" /></label>
          <small>Let this page reach Ollama by starting it with <code>OLLAMA_ORIGINS=${location.origin} ollama serve</code>. Works best in Chrome.</small>
        </div>
        <div class="group" data-for="lmstudio">
          <label class="row">Address <input name="lmstudioUrl" autocomplete="off" spellcheck="false" placeholder="${DEFAULTS.lmstudioUrl}" /></label>
          <label class="row">Model <input name="lmstudioModel" autocomplete="off" spellcheck="false" placeholder="the model's identifier" /></label>
          <small>Turn on CORS in LM Studio's server settings so this page may call it.</small>
        </div>
      </fieldset>
      <fieldset>
        <legend>Narrator voice</legend>
        <label class="row">ElevenLabs key <input name="elevenlabsKey" type="password" autocomplete="off" spellcheck="false" placeholder="optional" /></label>
        <label class="row">Voice ID <input name="elevenlabsVoice" autocomplete="off" spellcheck="false" placeholder="${DEFAULTS.elevenlabsVoice}" /></label>
        <small>Uses your ElevenLabs credits: at most ${now.voice.maxChars.toLocaleString('en-GB')} characters per visit. If your plan can't use the voice, a built-in one is used instead.</small>
      </fieldset>
      <div class="keys-actions">
        <button type="button" data-act="save">Save and reload</button>
        <button type="button" data-act="forget" class="quiet">Forget my keys</button>
      </div>
    </div>`;

  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: keyof PlayerKeys) => root.querySelector<T>(`[name="${name}"]`)!;
  const names: (keyof PlayerKeys)[] = ['rooms', 'openrouterKey', 'openrouterModel', 'ollamaUrl', 'ollamaModel', 'lmstudioUrl', 'lmstudioModel', 'elevenlabsKey', 'elevenlabsVoice'];
  for (const n of names) field(n).value = (keys[n] as string | undefined) ?? '';
  const select = field<HTMLSelectElement>('rooms');
  const showGroup = () => {
    for (const g of root.querySelectorAll<HTMLElement>('.group')) g.hidden = g.dataset.for !== select.value;
  };
  select.addEventListener('change', showGroup);
  showGroup();

  root.querySelector('[data-act="save"]')!.addEventListener('click', () => {
    const next = Object.fromEntries(names.map((n) => [n, field(n).value])) as unknown as PlayerKeys;
    next.rooms = (select.value as RoomsBackend) || 'off';
    saveKeys(next);
    location.reload();
  });
  root.querySelector('[data-act="forget"]')!.addEventListener('click', () => {
    forgetKeys();
    location.reload();
  });
  // Open it straight away when the saved settings have a problem, so the fix is one click away.
  if (now.rooms?.via === 'player' && now.rooms.config.problem) root.open = true;
  return root;
}
