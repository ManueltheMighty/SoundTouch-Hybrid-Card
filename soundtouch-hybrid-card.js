/**
 * SoundTouch Hybrid Card - standalone Home Assistant Lovelace custom card
 *
 * Example configuration:
 *
 * type: custom:soundtouch-hybrid-card
 * bose_url: /api/hassio_ingress/YOUR-BOSE-INGRESS-TOKEN
 * mass_url: /api/hassio_ingress/YOUR-MASS-INGRESS-TOKEN
 * speakers:
 *   Kitchen: media_player.kitchen_speaker
 *   Living Room: media_player.living_room
 *
 * bose_url / mass_url can also be full external URLs
 * (e.g. http://192.168.1.50:8095), if MASS/Bose run on a
 * different server and are not reachable via HA ingress.
 * In that case the respective server must allow CORS
 * requests from the Home Assistant domain.
 *
 * "speakers" maps the name as reported by the Bose backend
 * to the matching Home Assistant media_player entity. This is
 * only needed for the heart ("favorite") button, to read the
 * currently playing media_content_id. If a speaker is not
 * listed here, the heart button is simply hidden for it.
 */

class SoundtouchHybridCard extends HTMLElement {

  setConfig(config) {
    if (!config.bose_url) {
      throw new Error("bose_url is required (e.g. the Bose add-on's ingress path)");
    }
    this._config = config;
    this._speakers = config.speakers || {};
    this._activeIndex = 0;
    this._devices = [];
    this._presetMap = {};
    this._settings = {};
    this._interacting = false;

    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._buildBaseDom();
    }
  }

  set hass(hass) {
    this._hass = hass;
    // Only re-render if we already have device data
    if (this._devices.length) this._render();
  }

  getCardSize() {
    return 5;
  }

  connectedCallback() {
    this._loadStatus();
    this._loadPresetMap();
    this._loadSettings();
    this._pollTimer = setInterval(() => this._loadStatus(), 2000);
  }

  disconnectedCallback() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  // ---------- Backend communication ----------

  async _boseFetch(path, options) {
    const base = this._config.bose_url.replace(/\/$/, "");
    return fetch(`${base}/${path}`, options);
  }

  async _massFetch(command, args) {
    const base = this._config.mass_url ? this._config.mass_url.replace(/\/$/, "") : null;
    if (!base) {
      console.warn("soundtouch-hybrid-card: mass_url not configured, cannot set favorite");
      return Promise.resolve();
    }
    return fetch(`${base}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: "1", command, args })
    });
  }

  async _loadStatus() {
    try {
      const res = await this._boseFetch("api/status");
      this._devices = await res.json();
      this._render();
    } catch (e) {
      console.error("soundtouch-hybrid-card: could not load status", e);
    }
  }

  async _loadPresetMap() {
    try {
      const res = await this._boseFetch("api/manager/library");
      if (!res.ok) return;
      const items = await res.json();
      const map = {};
      for (const item of items) {
        if (item.slot > 0) {
          if (item.speakerIp) {
            map[item.speakerIp + "_" + item.slot] = item;
          } else {
            map["_" + item.slot] = item;
          }
        }
      }
      this._presetMap = map;
      this._render();
    } catch (e) {
      console.error("soundtouch-hybrid-card: could not load preset map", e);
    }
  }

  async _loadSettings() {
    try {
      const res = await this._boseFetch("api/admin/settings");
      if (!res.ok) return;
      this._settings = await res.json();
      this._render();
    } catch (e) {
      console.error("soundtouch-hybrid-card: could not load settings", e);
    }
  }

  async _sendKey(ip, key) {
    await this._boseFetch("api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, key })
    });
    setTimeout(() => this._loadStatus(), 600);
  }

  async _sendVolume(ip, value) {
    await this._boseFetch("api/volume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, value })
    });
  }

  async _sendGroupVolume(masterIp, delta) {
    await this._boseFetch("api/zone_volume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ masterIp, delta })
    });
  }

  async _sendJoin(slaveIp) {
    const candidates = this._devices.filter(d =>
      d.ip !== slaveIp && d.online && !d.isStandby
    );
    const body = { slaveIp };
    if (candidates.length === 1) body.targetMasterIp = candidates[0].ip;
    await this._boseFetch("api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    setTimeout(() => this._loadStatus(), 600);
  }

  async _addFavorite(deviceName) {
    const entityId = this._speakers[deviceName];
    if (!entityId || !this._hass) return;
    const state = this._hass.states[entityId];
    const mediaId = state && state.attributes && state.attributes.media_content_id;
    if (!mediaId) {
      console.warn("soundtouch-hybrid-card: no media_content_id found for", entityId);
      return;
    }
    await this._massFetch("music/favorites/add_item", { item: mediaId });
  }

  // ---------- UI ----------

  _buildBaseDom() {
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    this.shadowRoot.appendChild(style);

    this._cardEl = document.createElement("div");
    this._cardEl.className = "card";
    this.shadowRoot.appendChild(this._cardEl);
  }

  _cycle(direction) {
    if (!this._devices.length) return;
    this._activeIndex = (this._activeIndex + direction + this._devices.length) % this._devices.length;
    this._render();
  }

  _renderPresetRow(d, nums, extraClass) {
    const cells = nums.map(n => {
      const active = d.activePreset === n;
      const item = this._presetMap[d.ip + "_" + n] || this._presetMap["_" + n];
      const hasImage = item && item.image && item.image !== "custom_url";
      const inner = hasImage
        ? `<img src="${item.image}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
           <span class="preset-num-badge">${n}</span>`
        : `<span class="preset-num-fallback">${n}</span>`;
      return `<button class="preset ${hasImage ? "" : "preset-empty"} ${active ? "active" : ""}" data-preset="${n}">${inner}</button>`;
    }).join("");
    return `<div class="presets ${extraClass || ""}">${cells}</div>`;
  }

  _render() {
    if (!this._devices.length) {
      this._cardEl.innerHTML = `<div class="empty">No speakers found</div>`;
      return;
    }
    if (this._activeIndex >= this._devices.length) this._activeIndex = 0;
    const d = this._devices[this._activeIndex];

    if (!d.online) {
      this._cardEl.innerHTML = `
        <div class="nav">
          <button class="arrow" data-dir="-1">‹</button>
          <span class="name">${d.name} (Offline)</span>
          <button class="arrow" data-dir="1">›</button>
        </div>
        <div class="offline-msg">Offline</div>
      `;
      this._bindNav();
      return;
    }

    const isStandby = d.isStandby;
    const hasArt = d.art && d.art !== "custom_url";
    const showHeart = !!this._speakers[d.name];
    const showSync = true;

    const source = (d.source || "").toUpperCase();
    let stateIconHtml = "";
    if (!hasArt) {
      if (isStandby) {
        stateIconHtml = SOUNDWAVE_ICON;
      } else if (source.includes("BLUETOOTH")) {
        stateIconHtml = BLUETOOTH_ICON;
      } else if (source.includes("AUX")) {
        stateIconHtml = `<span class="state-icon-text">AUX</span>`;
      }
    }

    this._cardEl.style.backgroundImage = hasArt ? `url('${d.art}')` : "none";
    this._cardEl.classList.toggle("has-bg-art", hasArt);
    this._cardEl.classList.toggle("controls-playing", hasArt);

    const basePresetsHtml = this._renderPresetRow(d, [1, 2, 3, 4, 5, 6]);
    const extPresetsHtml = this._settings.doubleTapPresets
      ? this._renderPresetRow(d, [11, 22, 33, 44, 55, 66], "presets-ext")
      : "";

    const isGroupMaster = d.zone && d.zone.master === d.mac;
    const members = isGroupMaster
      ? this._devices.filter(dev => dev.zone && dev.zone.master === d.mac)
      : [];
    const groupMaxVolume = members.length
      ? Math.max(d.volume, ...members.map(m => m.volume))
      : 0;

    this._cardEl.innerHTML = `
      ${stateIconHtml ? `<div class="state-icon">${stateIconHtml}</div>` : ""}
      <div class="shadow-top"></div>
      <div class="shadow-bottom"></div>

      <div class="nav">
        <button class="arrow" data-dir="-1">‹</button>
        <span class="name">${d.name}</span>
        <button class="arrow" data-dir="1">›</button>
      </div>

      <div class="playing-info">
        <div class="meta">
          <div class="title-row">
            <span class="track">${isStandby ? "Off" : (d.track || d.source || "")}</span>
            ${showHeart && !isStandby ? `<button class="heart" title="Add to favorites">🤍</button>` : ""}
          </div>
          <span class="artist">${isStandby ? "" : (d.artist || "")}</span>
        </div>
      </div>

      <div class="controls">
        <button class="btn power ${!isStandby ? "on" : ""}" data-action="power">${POWER_ICON}</button>
        <button class="btn" data-action="prev" ${isStandby ? "disabled" : ""}>⏮</button>
        <button class="btn" data-action="playpause" ${isStandby ? "disabled" : ""}>⏯</button>
        <button class="btn" data-action="next" ${isStandby ? "disabled" : ""}>⏭</button>
        ${showSync ? `<button class="btn join" data-action="join" title="Sync to Master">🔗</button>` : ""}
      </div>

      ${basePresetsHtml}
      ${extPresetsHtml}

      <div class="volume-row">
        <span class="vol-label">VOL</span>
        <input type="range" class="volume" min="0" max="100" value="${d.volume}" ${isStandby ? "disabled" : ""}>
        <span class="vol-value">${d.volume}</span>
      </div>

      ${isGroupMaster && members.length ? `
      <div class="volume-row group-volume-row">
        <span class="vol-label">GRP</span>
        <input type="range" class="group-volume" min="0" max="100" value="${groupMaxVolume}">
        <span class="vol-value">${groupMaxVolume}</span>
      </div>` : ""}
    `;

    this._bindNav();
    this._bindControls(d);
  }

  _bindNav() {
    this._cardEl.querySelectorAll(".arrow").forEach(btn => {
      btn.onclick = () => this._cycle(parseInt(btn.dataset.dir, 10));
    });
  }

  _bindControls(d) {
    const heart = this._cardEl.querySelector(".heart");
    if (heart) {
      heart.onclick = async () => {
        heart.disabled = true;
        heart.textContent = "⏳";
        try {
          await this._addFavorite(d.name);
          heart.textContent = "❤️";
        } catch (e) {
          heart.textContent = "🤍";
          console.error(e);
        } finally {
          heart.disabled = false;
        }
      };
    }

    const power = this._cardEl.querySelector('[data-action="power"]');
    if (power) power.onclick = () => this._sendKey(d.ip, "POWER");

    const prev = this._cardEl.querySelector('[data-action="prev"]');
    if (prev) prev.onclick = () => this._sendKey(d.ip, "PREV_TRACK");

    const playpause = this._cardEl.querySelector('[data-action="playpause"]');
    if (playpause) playpause.onclick = () => this._sendKey(d.ip, "PLAY_PAUSE");

    const next = this._cardEl.querySelector('[data-action="next"]');
    if (next) next.onclick = () => this._sendKey(d.ip, "NEXT_TRACK");

    const join = this._cardEl.querySelector('[data-action="join"]');
    if (join) join.onclick = () => this._sendJoin(d.ip);

    this._cardEl.querySelectorAll(".preset").forEach(btn => {
      btn.onclick = () => this._sendKey(d.ip, `PRESET_${btn.dataset.preset}`);
    });

    const volume = this._cardEl.querySelector(".volume");
    if (volume) {
      let throttle = null;
      volume.oninput = () => {
        this._cardEl.querySelector(".vol-value").textContent = volume.value;
        if (!throttle) {
          throttle = setTimeout(() => {
            this._sendVolume(d.ip, volume.value);
            throttle = null;
          }, 150);
        }
      };
    }

    const groupVolume = this._cardEl.querySelector(".group-volume");
    if (groupVolume) {
      let lastRef = parseInt(groupVolume.value, 10);
      let throttle = null;
      groupVolume.oninput = () => {
        const val = parseInt(groupVolume.value, 10);
        groupVolume.parentElement.querySelector(".vol-value").textContent = val;
        if (!throttle) {
          throttle = setTimeout(() => {
            const delta = val - lastRef;
            if (delta !== 0) this._sendGroupVolume(d.ip, delta);
            lastRef = val;
            throttle = null;
          }, 150);
        }
      };
    }
  }

  static getConfigElement() {
    return document.createElement("soundtouch-hybrid-card-editor");
  }

  static getStubConfig() {
    return { bose_url: "", mass_url: "", speakers: {} };
  }
}

// ---------- Visual editor ----------

class SoundtouchHybridCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    if (!this._config.speakers) this._config.speakers = {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this.querySelectorAll("ha-entity-picker").forEach(p => { p.hass = this._hass; });
  }

  connectedCallback() {
    if (this._config) this._render();
  }

  _fireChanged() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true
    }));
  }

  _render() {
    this.innerHTML = `
      <style>
        .field { margin-bottom: 14px; padding: 0 16px; }
        label { display:block; font-size: 0.85em; margin-bottom: 4px; color: var(--secondary-text-color); }
        input[type=text] {
          width: 100%; box-sizing: border-box; padding: 8px; border-radius: 4px;
          border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #000);
        }
        .hint { font-size: 0.75em; color: var(--secondary-text-color); margin-top: 2px; }
        .speaker-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
        .speaker-row input[type=text] { flex: 1; }
        .speaker-row ha-entity-picker { flex: 2; }
        .remove-btn {
          cursor: pointer; background: none; border: none;
          color: var(--error-color, #e74c3c); font-size: 1.2em; line-height: 1; padding: 4px;
        }
        .add-btn {
          margin-top: 4px; cursor: pointer; background: var(--secondary-background-color, #eee);
          border: 1px solid var(--divider-color, #ccc); border-radius: 4px; padding: 6px 12px;
          color: var(--primary-text-color, #000);
        }
      </style>
      <div class="field">
        <label>Bose add-on URL</label>
        <input type="text" id="bose_url" value="${this._config.bose_url || ""}" placeholder="/api/hassio_ingress/... or http://IP:PORT">
        <div class="hint">Ingress path of the Bose SoundTouch Hybrid add-on, or a full external URL</div>
      </div>
      <div class="field">
        <label>Music Assistant URL (optional, for the favorite button)</label>
        <input type="text" id="mass_url" value="${this._config.mass_url || ""}" placeholder="/api/hassio_ingress/... or http://IP:PORT">
      </div>
      <div class="field">
        <label>Speaker mapping (Bose name → Home Assistant entity)</label>
        <div id="speakers-list"></div>
        <button type="button" class="add-btn">+ Add speaker</button>
      </div>
    `;

    this.querySelector("#bose_url").addEventListener("change", (e) => {
      this._config.bose_url = e.target.value;
      this._fireChanged();
    });
    this.querySelector("#mass_url").addEventListener("change", (e) => {
      this._config.mass_url = e.target.value;
      this._fireChanged();
    });
    this.querySelector(".add-btn").addEventListener("click", () => {
      const speakers = { ...this._config.speakers };
      let key = "New speaker";
      let i = 2;
      while (key in speakers) { key = `New speaker ${i++}`; }
      speakers[key] = "";
      this._config.speakers = speakers;
      this._fireChanged();
      this._render();
    });

    this._renderSpeakerRows();
  }

  _renderSpeakerRows() {
    const list = this.querySelector("#speakers-list");
    list.innerHTML = "";
    const entries = Object.entries(this._config.speakers || {});

    entries.forEach(([name, entity], index) => {
      const row = document.createElement("div");
      row.className = "speaker-row";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Bose name (e.g. Kitchen)";
      nameInput.value = name;
      nameInput.addEventListener("change", () => {
        const newSpeakers = {};
        Object.entries(this._config.speakers).forEach(([n, e], i) => {
          newSpeakers[i === index ? nameInput.value : n] = e;
        });
        this._config.speakers = newSpeakers;
        this._fireChanged();
      });

      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.value = entity;
      picker.includeDomains = ["media_player"];
      picker.addEventListener("value-changed", (e) => {
        e.stopPropagation();
        const currentName = Object.keys(this._config.speakers)[index];
        this._config.speakers = { ...this._config.speakers, [currentName]: e.detail.value };
        this._fireChanged();
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        const newSpeakers = {};
        Object.entries(this._config.speakers).forEach(([n, e], i) => {
          if (i !== index) newSpeakers[n] = e;
        });
        this._config.speakers = newSpeakers;
        this._fireChanged();
        this._render();
      });

      row.appendChild(nameInput);
      row.appendChild(picker);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }
}

customElements.define("soundtouch-hybrid-card-editor", SoundtouchHybridCardEditor);

const POWER_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/>
</svg>`;

const SOUNDWAVE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <line x1="3" y1="10" x2="3" y2="14"/>
  <line x1="7" y1="6" x2="7" y2="18"/>
  <line x1="11" y1="9" x2="11" y2="15"/>
  <line x1="15" y1="4" x2="15" y2="20"/>
  <line x1="19" y1="8" x2="19" y2="16"/>
</svg>`;

const BLUETOOTH_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/>
</svg>`;

const CARD_CSS = `
:host {
  display: block;
  position: relative;
  width: 100%;
}
:host::before {
  content: "";
  display: block;
  padding-top: 100%;
}
.card {
  position: absolute;
  inset: 0;
  aspect-ratio: 1 / 1;
  border-radius: var(--ha-card-border-radius, 12px);
  background: var(--card-background-color, #181818);
  background-size: cover;
  background-position: center;
  color: var(--primary-text-color, #e0e0e0);
  padding: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.card.has-bg-art::before {
  content: "";
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.35);
  z-index: 1;
}
.card > * {
  position: relative;
  z-index: 2;
}
.empty, .offline-msg {
  margin: auto;
  opacity: 0.6;
  text-align: center;
}
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.15);
  margin-bottom: 10px;
}
.arrow {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--divider-color, rgba(128,128,128,0.4));
  background: var(--secondary-background-color, rgba(128,128,128,0.12));
  color: inherit;
  font-size: 1.1rem;
  cursor: pointer;
}
.name {
  font-weight: 600;
  font-size: 0.85rem;
  letter-spacing: 0.5px;
}
.card.has-bg-art .name {
  color: #fff;
}
.playing-info {
  flex-grow: 1;
  display: flex;
  align-items: flex-end;
  margin-bottom: 10px;
}
.meta { width: 100%; overflow: hidden; }
.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.track {
  font-weight: bold;
  font-size: 1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.artist {
  font-size: 0.8rem;
  opacity: 0.75;
}
.card.has-bg-art .track,
.card.has-bg-art .artist {
  color: #fff;
  opacity: 1;
}
.card.has-bg-art .artist {
  opacity: 0.85;
}
.heart {
  background: none;
  border: none;
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}
.controls {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}
.btn {
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  border: 1px solid var(--divider-color, rgba(128,128,128,0.4));
  background: var(--secondary-background-color, rgba(128,128,128,0.12));
  color: inherit;
  font-size: 1.7rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.btn:disabled { opacity: 0.35; cursor: default; }
.btn svg {
  width: 55%;
  height: 55%;
}
.btn.power.on {
  background: var(--accent-color, #2ecc71);
  color: #000;
  border: none;
}
.controls-playing .btn {
  background: rgba(255,255,255,0.15);
  color: #fff;
  border-color: rgba(255,255,255,0.3);
}
.controls-playing .btn.power.on {
  background: rgba(255,255,255,0.9);
  color: #000;
}
.presets {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  margin-bottom: 10px;
}
.presets.presets-ext {
  margin-top: -6px;
}
.preset {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: 4px;
  border: 1px solid var(--divider-color, rgba(128,128,128,0.3));
  background: var(--secondary-background-color, rgba(128,128,128,0.1));
  color: inherit;
  font-size: 0.7rem;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preset img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  position: absolute;
  top: 0;
  left: 0;
}
.preset-num-badge {
  position: absolute;
  bottom: 1px;
  right: 2px;
  background: rgba(0,0,0,0.65);
  color: #fff;
  font-size: 0.6em;
  font-weight: bold;
  padding: 0 3px;
  border-radius: 3px;
  z-index: 2;
}
.preset-num-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
}
.preset.preset-empty {
  background: transparent;
  border-color: var(--divider-color, rgba(128,128,128,0.25));
}
.preset.active {
  box-shadow: 0 0 0 2px var(--accent-color, #2ecc71);
}
.card.has-bg-art .preset-num-fallback {
  color: #fff;
}
.card.has-bg-art .preset.preset-empty {
  border-color: rgba(255,255,255,0.3);
}
.volume-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.group-volume-row {
  margin-top: 6px;
}
.group-volume-row .vol-label { color: #9b59b6; }
.group-volume {
  accent-color: #9b59b6 !important;
}
.vol-label, .vol-value {
  font-size: 0.7rem;
  opacity: 0.7;
  width: 24px;
}
.vol-value { text-align: right; }
.card.has-bg-art .vol-label,
.card.has-bg-art .vol-value {
  color: #fff;
  opacity: 0.9;
}
input[type=range] {
  flex-grow: 1;
  accent-color: var(--accent-color, #2ecc71);
}
.shadow-top, .shadow-bottom {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 1;
  pointer-events: none;
}
.shadow-top {
  top: 0;
  height: 70px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0));
}
.shadow-bottom {
  bottom: 0;
  height: 90px;
  background: linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0));
}
.state-icon {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.16;
  color: var(--primary-text-color, #999);
}
.state-icon svg {
  width: 42%;
  height: 42%;
}
.state-icon-text {
  font-size: 2.6rem;
  font-weight: 800;
  letter-spacing: 2px;
}
`;

customElements.define("soundtouch-hybrid-card", SoundtouchHybridCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "soundtouch-hybrid-card",
  name: "SoundTouch Hybrid Card",
  description: "Control card for Bose SoundTouch speakers via SoundTouch Hybrid + Music Assistant"
});
