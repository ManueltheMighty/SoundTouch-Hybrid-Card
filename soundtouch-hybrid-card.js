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
 * Optional: mass_config_entry_id - ID of the Music Assistant integration
 * entry. Only needed for the search popup if it cannot be detected
 * automatically (e.g. for non-admin users).
 *
 * The search popup (magnifier button) uses the Home Assistant actions
 * music_assistant.search and music_assistant.play_media and is shown for
 * every speaker that is listed under "speakers".
 *
 * "speakers" maps the name as reported by the Bose backend
 * to the matching Home Assistant media_player entity. This is
 * only needed for the heart ("favorite") button, to read the
 * currently playing media_content_id. If a speaker is not
 * listed here, the heart button is simply hidden for it.
 */

// ---------- Security helpers ----------
// Everything coming from the backend (speaker names, track/artist metadata,
// artwork URLs) is untrusted: it can originate from internet radio metadata,
// Bluetooth/AUX sources or streaming services.

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

// Returns a normalized http(s) URL (relative URLs are resolved against the
// current origin), or null for anything else (javascript:, data:, etc.).
const safeUrl = (value) => {
  if (typeof value !== "string" || !value) return null;
  try {
    const u = new URL(value, window.location.origin);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (e) {
    // invalid URL
  }
  return null;
};

// ---- helpers for search results (all fields are untrusted) ----
const nameOf = (v) => (typeof v === "string" ? v : v && typeof v.name === "string" ? v.name : "");

const itemSubtitle = (it, group) => {
  const a = it.artists ?? it.artist;
  let artists = "";
  if (Array.isArray(a)) artists = a.map(nameOf).filter(Boolean).join(", ");
  else artists = nameOf(a);
  const album = nameOf(it.album);
  if (group.type === "track") return [artists, album].filter(Boolean).join(" · ") || group.single;
  if (group.type === "album") return artists || group.single;
  return group.single;
};

const itemImage = (it) => {
  const first = it.metadata && Array.isArray(it.metadata.images) ? it.metadata.images[0] : null;
  const candidates = [it.image, it.thumb, it.image_url, first];
  for (const c of candidates) {
    const raw = typeof c === "string" ? c : c && typeof c.path === "string" ? c.path : null;
    const url = safeUrl(raw);
    if (url) return url;
  }
  return null;
};

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

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
    this._likedIds = {};
    this._likePending = {};

    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._buildBaseDom();
    }
  }

  set hass(hass) {
    this._hass = hass;
    // Only re-render if we already have device data, and not while the
    // user is actively dragging a slider (hass updates for unrelated
    // entities would otherwise reset the slider mid-drag).
    if (this._devices.length && !this._interacting) this._render();
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
    if (this._searchDlg) this._closeSearch();
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
    if (this._interacting) return;
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

  // media_content_id of the song currently playing on the given speaker
  _currentMediaId(deviceName) {
    const entityId = this._speakers[deviceName];
    if (!entityId || !this._hass) return null;
    const state = this._hass.states[entityId];
    return (state && state.attributes && state.attributes.media_content_id) || null;
  }

  // Returns true if Music Assistant accepted the request
  async _addFavorite(deviceName) {
    const mediaId = this._currentMediaId(deviceName);
    if (!mediaId) {
      console.warn("soundtouch-hybrid-card: no media_content_id found for", deviceName);
      return false;
    }
    const res = await this._massFetch("music/favorites/add_item", { item: mediaId });
    return !!(res && res.ok);
  }

  _isLiked(deviceName) {
    const mediaId = this._currentMediaId(deviceName);
    return !!mediaId && this._likedIds[deviceName] === mediaId;
  }

  // ---------- UI ----------

  _buildBaseDom() {
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    this.shadowRoot.appendChild(style);

    this._cardEl = document.createElement("div");
    this._cardEl.className = "card";
    this.shadowRoot.appendChild(this._cardEl);

    // The search popup lives next to (not inside) the card element, because
    // the card element is re-rendered every couple of seconds.
    this._buildSearchDialog();
  }

  // ---------- Search popup ----------

  _buildSearchDialog() {
    const dlg = document.createElement("dialog");
    dlg.className = "search-dlg";
    dlg.innerHTML = `
      <div class="dlg">
        <div class="dlg-head">
          <input type="search" class="dlg-input" placeholder="Search songs, albums, artists…"
                 autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
          <button type="button" class="dlg-close" aria-label="Close">${CLOSE_ICON}</button>
        </div>
        <div class="dlg-target"></div>
        <div class="dlg-body"></div>
      </div>`;
    this.shadowRoot.appendChild(dlg);

    this._searchDlg = dlg;
    this._searchInput = dlg.querySelector(".dlg-input");
    this._searchTargetEl = dlg.querySelector(".dlg-target");
    this._searchBody = dlg.querySelector(".dlg-body");
    this._searchSeq = 0;
    this._searchTimer = null;
    this._searchLastQuery = "";

    dlg.querySelector(".dlg-close").addEventListener("click", () => this._closeSearch());
    // Click on the backdrop (the dialog element itself) closes the popup
    dlg.addEventListener("click", (e) => { if (e.target === dlg) this._closeSearch(); });
    this._searchInput.addEventListener("input", () => {
      clearTimeout(this._searchTimer);
      const q = this._searchInput.value.trim();
      if (q.length < 2) {
        this._searchSeq++;
        this._setSearchStatus("Type at least 2 characters to search.");
        return;
      }
      this._searchTimer = setTimeout(() => this._runSearch(q), 350);
    });
    this._searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(this._searchTimer);
        const q = this._searchInput.value.trim();
        if (q.length >= 2) this._runSearch(q);
      }
    });
    this._setSearchStatus("Search your music library and streaming services.");
  }

  _openSearch(speakerName) {
    this._searchTarget = speakerName;
    this._searchTargetEl.textContent = `Play on ${speakerName}`;
    if (typeof this._searchDlg.showModal === "function") {
      if (!this._searchDlg.open) this._searchDlg.showModal();
    } else {
      this._searchDlg.setAttribute("open", "");
    }
    requestAnimationFrame(() => {
      this._searchInput.focus();
      this._searchInput.select();
    });
  }

  _closeSearch() {
    clearTimeout(this._searchTimer);
    this._searchSeq++;
    if (typeof this._searchDlg.close === "function") {
      if (this._searchDlg.open) this._searchDlg.close();
    } else {
      this._searchDlg.removeAttribute("open");
    }
  }

  _setSearchStatus(text, isError = false) {
    this._searchBody.replaceChildren();
    const el = document.createElement("div");
    el.className = "dlg-status" + (isError ? " error" : "");
    el.textContent = text;
    this._searchBody.appendChild(el);
  }

  async _getMaEntryId() {
    if (this._config.mass_config_entry_id) return this._config.mass_config_entry_id;
    if (this._maEntryId) return this._maEntryId;
    const entries = await this._hass.callWS({ type: "config_entries/get", domain: "music_assistant" });
    const list = Array.isArray(entries) ? entries : [];
    const entry = list.find((e) => e.domain === "music_assistant" && e.state === "loaded") || list[0];
    if (!entry) {
      const err = new Error("The Music Assistant integration was not found in Home Assistant.");
      err.userMessage = err.message;
      throw err;
    }
    this._maEntryId = entry.entry_id;
    return this._maEntryId;
  }

  async _searchMedia(query) {
    let entryId;
    try {
      entryId = await this._getMaEntryId();
    } catch (e) {
      if (e.userMessage) throw e;
      const err = new Error("Could not look up the Music Assistant integration. Set mass_config_entry_id in the card configuration.");
      err.userMessage = err.message;
      throw err;
    }
    const res = await this._hass.callWS({
      type: "call_service",
      domain: "music_assistant",
      service: "search",
      service_data: {
        config_entry_id: entryId,
        name: query,
        media_type: ["track", "album", "artist", "playlist", "radio"],
        limit: 5
      },
      return_response: true
    });
    return (res && res.response) || res || {};
  }

  async _runSearch(query) {
    if (!this._hass) return;
    const seq = ++this._searchSeq;
    this._searchLastQuery = query;
    this._setSearchStatus("Searching…");
    try {
      const data = await this._searchMedia(query);
      if (seq !== this._searchSeq) return; // a newer search replaced this one
      this._renderSearchResults(data);
    } catch (e) {
      if (seq !== this._searchSeq) return;
      console.error("soundtouch-hybrid-card: search failed", e);
      this._setSearchStatus(e.userMessage || "Search failed. Check that Music Assistant is running.", true);
    }
  }

  _renderSearchResults(data) {
    const groups = [
      { key: "tracks", label: "Tracks", type: "track", single: "Track" },
      { key: "albums", label: "Albums", type: "album", single: "Album" },
      { key: "artists", label: "Artists", type: "artist", single: "Artist" },
      { key: "playlists", label: "Playlists", type: "playlist", single: "Playlist" },
      { key: "radio", label: "Radio", type: "radio", single: "Radio" }
    ];
    this._searchBody.replaceChildren();
    let total = 0;

    for (const g of groups) {
      const items = (Array.isArray(data[g.key]) ? data[g.key] : []).filter(
        (it) => it && typeof it.uri === "string" && it.uri
      );
      if (!items.length) continue;
      total += items.length;

      const heading = document.createElement("div");
      heading.className = "dlg-heading";
      heading.textContent = g.label;
      this._searchBody.appendChild(heading);

      for (const it of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "res";

        const thumb = document.createElement("span");
        thumb.className = "res-thumb";
        const imgUrl = itemImage(it);
        if (imgUrl) {
          const img = document.createElement("img");
          img.alt = "";
          img.loading = "lazy";
          img.addEventListener("error", () => { img.remove(); thumb.innerHTML = NOTE_ICON; });
          img.src = imgUrl;
          thumb.appendChild(img);
        } else {
          thumb.innerHTML = NOTE_ICON;
        }

        const text = document.createElement("span");
        text.className = "res-text";
        const title = document.createElement("span");
        title.className = "res-title";
        title.textContent = String(it.name ?? it.title ?? it.uri);
        const sub = document.createElement("span");
        sub.className = "res-sub";
        sub.textContent = itemSubtitle(it, g);
        text.append(title, sub);

        row.append(thumb, text);
        row.addEventListener("click", () => this._playMedia(it.uri, g.type, row));
        this._searchBody.appendChild(row);
      }
    }

    if (!total) this._setSearchStatus(`No results for “${this._searchLastQuery}”.`);
  }

  async _playMedia(uri, mediaType, row) {
    const entityId = this._speakers[this._searchTarget];
    if (!entityId || !this._hass) {
      this._setSearchStatus("This speaker is not mapped to a Home Assistant entity (see “speakers” in the card configuration).", true);
      return;
    }
    row.classList.add("busy");
    try {
      await this._hass.callService(
        "music_assistant", "play_media",
        { media_id: uri, media_type: mediaType },
        { entity_id: entityId }
      );
      this._closeSearch();
      setTimeout(() => this._loadStatus(), 1500);
    } catch (e) {
      console.error("soundtouch-hybrid-card: could not start playback", e);
      row.classList.remove("busy");
      const msg = (e && e.message) ? e.message : "Could not start playback.";
      this._setSearchStatus(`Could not start playback: ${msg}`, true);
    }
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
      const hasImage = !!(item && item.image && item.image !== "custom_url" && safeUrl(item.image));
      // The image URL is NOT interpolated here; it is assigned via the DOM
      // property in _applyImages() after rendering.
      const inner = hasImage
        ? `<img class="preset-img" data-n="${n}" alt="">
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
          <span class="name">${escapeHtml(d.name)} (Offline)</span>
          <button class="arrow" data-dir="1">›</button>
        </div>
        <div class="offline-msg">Offline</div>
      `;
      this._bindNav();
      return;
    }

    const isStandby = d.isStandby;
    const artUrl = d.art && d.art !== "custom_url" ? safeUrl(d.art) : null;
    const hasArt = !!artUrl;
    const showHeart = !!this._speakers[d.name];
    const volume = toNumber(d.volume);
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

    this._cardEl.style.backgroundImage = hasArt
      ? `url("${artUrl.replace(/["\\\n\r]/g, encodeURIComponent)}")`
      : "none";
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
      ? Math.max(volume, ...members.map(m => toNumber(m.volume)))
      : 0;

    this._cardEl.innerHTML = `
      ${stateIconHtml ? `<div class="state-icon">${stateIconHtml}</div>` : ""}
      <div class="shadow-top"></div>
      <div class="shadow-bottom"></div>

      <div class="nav">
        <button class="arrow" data-dir="-1">‹</button>
        <span class="name">${escapeHtml(d.name)}</span>
        <button class="arrow" data-dir="1">›</button>
      </div>

      <div class="playing-info">
        <div class="meta">
          <div class="title-row">
            <span class="track">${isStandby ? "Off" : escapeHtml(d.track || d.source || "")}</span>
            <div class="title-actions">
              ${showHeart ? `<button class="search-btn" title="Search music">${SEARCH_ICON}</button>` : ""}
              ${showHeart && !isStandby ? (() => {
                const liked = this._isLiked(d.name);
                const pending = !!this._likePending[d.name];
                return `<button class="heart ${liked ? "liked" : ""} ${pending ? "pending" : ""}" title="${liked ? "Added to favorites" : "Add to favorites"}">${liked ? HEART_FILLED_ICON : HEART_OUTLINE_ICON}</button>`;
              })() : ""}
            </div>
          </div>
          <span class="artist">${isStandby ? "" : escapeHtml(d.artist || "")}</span>
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
        <div class="slider-wrap">
          <span class="vol-bubble"></span>
          <input type="range" class="volume slider-guarded" min="0" max="100" value="${volume}" ${isStandby ? "disabled" : ""}>
          <div class="thumb-handle"></div>
        </div>
        <span class="vol-value">${volume}</span>
      </div>

      ${isGroupMaster && members.length ? `
      <div class="volume-row group-volume-row">
        <span class="vol-label">GRP</span>
        <div class="slider-wrap">
          <span class="vol-bubble"></span>
          <input type="range" class="group-volume slider-guarded" min="0" max="100" value="${groupMaxVolume}">
          <div class="thumb-handle"></div>
        </div>
        <span class="vol-value">${groupMaxVolume}</span>
      </div>` : ""}
    `;

    this._bindNav();
    this._bindControls(d);
    this._applyPresetImages(d);
  }

  _applyPresetImages(d) {
    this._cardEl.querySelectorAll("img.preset-img").forEach((img) => {
      const n = img.dataset.n;
      const item = this._presetMap[d.ip + "_" + n] || this._presetMap["_" + n];
      const url = safeUrl(item && item.image);
      if (!url) {
        img.remove();
        return;
      }
      img.addEventListener("error", () => {
        img.style.display = "none";
      });
      img.src = url;
    });
  }

  _bindNav() {
    this._cardEl.querySelectorAll(".arrow").forEach(btn => {
      btn.onclick = () => this._cycle(parseInt(btn.dataset.dir, 10));
    });
  }

  _bindControls(d) {
    const searchBtn = this._cardEl.querySelector(".search-btn");
    if (searchBtn) searchBtn.onclick = () => this._openSearch(d.name);

    const heart = this._cardEl.querySelector(".heart");
    if (heart) {
      heart.onclick = async () => {
        const name = d.name;
        // Already liked or request in flight: nothing to do
        if (this._isLiked(name) || this._likePending[name]) return;

        // The card re-renders regularly, so the state lives on the card,
        // not on the button element.
        const mediaId = this._currentMediaId(name);
        this._likePending[name] = true;
        this._render();
        try {
          if (await this._addFavorite(name)) {
            this._likedIds[name] = mediaId;
          }
        } catch (e) {
          console.error("soundtouch-hybrid-card: could not add favorite", e);
        } finally {
          this._likePending[name] = false;
          this._render();
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
      this._bindSliderBubble(volume);
      volume.addEventListener("input", () => {
        this._cardEl.querySelector(".volume-row:not(.group-volume-row) .vol-value").textContent = volume.value;
        if (!throttle) {
          throttle = setTimeout(() => {
            this._sendVolume(d.ip, volume.value);
            throttle = null;
          }, 150);
        }
      });
    }

    const groupVolume = this._cardEl.querySelector(".group-volume");
    if (groupVolume) {
      let lastRef = parseInt(groupVolume.value, 10);
      let throttle = null;
      this._bindSliderBubble(groupVolume);
      groupVolume.addEventListener("input", () => {
        const val = parseInt(groupVolume.value, 10);
        groupVolume.closest(".volume-row").querySelector(".vol-value").textContent = val;
        if (!throttle) {
          throttle = setTimeout(() => {
            const delta = val - lastRef;
            if (delta !== 0) this._sendGroupVolume(d.ip, delta);
            lastRef = val;
            throttle = null;
          }, 150);
        }
      });
    }
  }

  _bindSliderBubble(input) {
    const wrap = input.closest(".slider-wrap");
    const bubble = wrap && wrap.querySelector(".vol-bubble");
    const handle = wrap && wrap.querySelector(".thumb-handle");
    if (!wrap || !bubble || !handle) return;

    const THUMB = 18;         // normal thumb size (px), see CSS
    const THUMB_ACTIVE = 30;  // enlarged thumb size while dragging (px)
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const thumbSize = () => (input.classList.contains("active") ? THUMB_ACTIVE : THUMB);
    const fraction = () => (parseFloat(input.value) - min) / (max - min);

    // Pure CSS positioning, no layout measurement needed
    const leftFor = () => `calc(${thumbSize() / 2}px + (100% - ${thumbSize()}px) * ${fraction()})`;
    const place = () => {
      const left = leftFor();
      bubble.style.left = left;
      handle.style.left = left;
      bubble.textContent = input.value;
    };

    const start = () => {
      this._interacting = true;
      input.classList.add("active");
      bubble.classList.add("visible");
      place();
    };
    const end = () => {
      input.classList.remove("active");
      bubble.classList.remove("visible");
      place();
      // Keep polling paused briefly so the device has time to catch up
      // to the value we just sent, avoiding a visible snap-back.
      setTimeout(() => { this._interacting = false; }, 600);
    };

    // Mouse / pen: the native slider works as usual
    input.addEventListener("pointerdown", () => { if (!input.disabled) start(); });
    input.addEventListener("pointerup", end);
    input.addEventListener("pointercancel", end);
    input.addEventListener("input", place);

    // Touch screens: the input itself ignores touches (see CSS), so a stray
    // tap or a scroll gesture over the slider never changes the volume.
    // Only dragging the thumb handle does.
    let grabOffset = 0;
    handle.addEventListener("pointerdown", (e) => {
      if (input.disabled) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      start();
      const rect = input.getBoundingClientRect();
      const size = thumbSize();
      const thumbCenterX = rect.left + size / 2 + fraction() * (rect.width - size);
      grabOffset = e.clientX - thumbCenterX;
    });
    handle.addEventListener("pointermove", (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const rect = input.getBoundingClientRect();
      const size = thumbSize();
      const centerX = e.clientX - grabOffset;
      const f = Math.max(0, Math.min(1, (centerX - rect.left - size / 2) / (rect.width - size)));
      const value = Math.round(min + f * (max - min));
      if (String(value) === input.value) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const release = (e) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      end();
    };
    handle.addEventListener("pointerup", release);
    handle.addEventListener("pointercancel", release);

    place();
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
        <input type="text" id="bose_url" value="${escapeHtml(this._config.bose_url || "")}" placeholder="/api/hassio_ingress/... or http://IP:PORT">
        <div class="hint">Ingress path of the Bose SoundTouch Hybrid add-on, or a full external URL</div>
      </div>
      <div class="field">
        <label>Music Assistant URL (optional, for the favorite button)</label>
        <input type="text" id="mass_url" value="${escapeHtml(this._config.mass_url || "")}" placeholder="/api/hassio_ingress/... or http://IP:PORT">
      </div>
      <div class="field">
        <label>Music Assistant config entry ID (optional, for the search popup)</label>
        <input type="text" id="mass_config_entry_id" value="${escapeHtml(this._config.mass_config_entry_id || "")}" placeholder="Detected automatically if left empty">
        <div class="hint">Only needed if the search popup cannot find the Music Assistant integration on its own</div>
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
    this.querySelector("#mass_config_entry_id").addEventListener("change", (e) => {
      const v = e.target.value.trim();
      if (v) this._config.mass_config_entry_id = v;
      else delete this._config.mass_config_entry_id;
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

const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
</svg>`;

const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
</svg>`;

const NOTE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
</svg>`;

const HEART_OUTLINE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>
</svg>`;

const HEART_FILLED_ICON = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
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
/* ---------- Search popup ---------- */
.search-dlg {
  padding: 0;
  border: none;
  border-radius: 16px;
  width: min(92vw, 560px);
  max-width: none;
  height: min(80vh, 640px);
  height: min(80dvh, 640px);
  background: var(--card-background-color, #1c1c1c);
  color: var(--primary-text-color, #e0e0e0);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  overflow: hidden;
}
.search-dlg[open] { display: block; }
.search-dlg::backdrop { background: rgba(0,0,0,0.55); }
.dlg {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.dlg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.3));
}
.dlg-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  font-size: 16px; /* 16px prevents iOS from zooming into the field */
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--divider-color, rgba(128,128,128,0.4));
  background: var(--secondary-background-color, rgba(128,128,128,0.12));
  color: inherit;
  outline: none;
}
.dlg-input:focus { border-color: var(--accent-color, #2ecc71); }
.dlg-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.dlg-close svg { width: 24px; height: 24px; }
.dlg-target {
  padding: 8px 16px 0;
  font-size: 0.75rem;
  opacity: 0.65;
}
.dlg-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 8px 12px;
}
.dlg-status {
  padding: 28px 16px;
  text-align: center;
  opacity: 0.7;
  font-size: 0.9rem;
}
.dlg-status.error { color: var(--error-color, #e74c3c); opacity: 1; }
.dlg-heading {
  padding: 14px 8px 4px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  opacity: 0.6;
}
.res {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.res:hover, .res:focus-visible { background: var(--secondary-background-color, rgba(128,128,128,0.15)); outline: none; }
.res.busy { opacity: 0.5; pointer-events: none; }
.res-thumb {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--secondary-background-color, rgba(128,128,128,0.2));
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
}
.res-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.res-thumb svg { width: 24px; height: 24px; opacity: 0.5; }
.res-text { display: flex; flex-direction: column; min-width: 0; }
.res-title {
  font-weight: 600;
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.res-sub {
  font-size: 0.8rem;
  opacity: 0.65;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- Card ---------- */
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
  color: inherit;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.heart svg {
  width: 24px;
  height: 24px;
}
.title-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.search-btn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.search-btn svg {
  width: 24px;
  height: 24px;
}
.card.has-bg-art .search-btn {
  color: #fff;
}
.heart.pending {
  opacity: 0.5;
  cursor: default;
}
.heart.liked {
  color: #e74c3c;
  cursor: default;
}
.card.has-bg-art .heart:not(.liked) {
  color: #fff;
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
  position: relative;
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
  -webkit-appearance: none;
  appearance: none;
  flex-grow: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--divider-color, rgba(128,128,128,0.3));
  cursor: pointer;
  touch-action: pan-y;
}
input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-color, #2ecc71);
  cursor: pointer;
  transition: width 0.1s ease, height 0.1s ease;
}
input[type=range]::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: var(--accent-color, #2ecc71);
  cursor: pointer;
  transition: width 0.1s ease, height 0.1s ease;
}
input[type=range].active::-webkit-slider-thumb {
  width: 30px;
  height: 30px;
}
input[type=range].active::-moz-range-thumb {
  width: 30px;
  height: 30px;
}
input[type=range].group-volume::-webkit-slider-thumb { background: #9b59b6; }
input[type=range].group-volume::-moz-range-thumb { background: #9b59b6; }
input[type=range]:disabled { opacity: 0.4; cursor: default; }

.slider-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.slider-wrap input[type=range] {
  width: 100%;
  margin: 0;
}
.thumb-handle {
  display: none;
  position: absolute;
  top: 50%;
  width: 48px;
  height: 48px;
  transform: translate(-50%, -50%);
  touch-action: none;
  z-index: 2;
}
/* Touch screens: only the thumb handle reacts, never the track */
@media (pointer: coarse) {
  input[type=range].slider-guarded { pointer-events: none; }
  .thumb-handle { display: block; }
}
input[type=range]:disabled ~ .thumb-handle { display: none; }

.vol-bubble {
  position: absolute;
  top: -26px;
  transform: translateX(-50%);
  background: var(--accent-color, #2ecc71);
  color: #000;
  font-weight: bold;
  font-size: 0.75rem;
  padding: 2px 7px;
  border-radius: 4px;
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
  z-index: 3;
}
.group-volume-row .vol-bubble {
  background: #9b59b6;
  color: #fff;
}
.vol-bubble.visible {
  opacity: 1;
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
