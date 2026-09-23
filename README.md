# SoundTouch Hybrid Card

A standalone Home Assistant Lovelace custom card to control Bose SoundTouch speakers via the [Bose SoundTouch Hybrid](https://github.com/TJGigs/Bose-SoundTouch-Hybrid) add-on, with a favorite button powered by [Music Assistant](https://music-assistant.io/).

## Requirements

- The [Bose SoundTouch Hybrid](https://github.com/TJGigs/Bose-SoundTouch-Hybrid) add-on is installed and running
- (Optional, for the favorite button) [Music Assistant](https://music-assistant.io/) is installed, and your Bose speakers are set up there as `media_player` entities

## Installation

### Via HACS

1. HACS -> Frontend -> menu (three dots) -> Custom repositories
2. Add this repository as a "Dashboard" / "Plugin"
3. Install "SoundTouch Hybrid Card"
4. Reload Home Assistant (hard browser reload)

### Manual

1. Copy `soundtouch-hybrid-card.js` to `config/www/`
2. Settings -> Dashboards -> Resources -> Add resource
   - URL: `/local/soundtouch-hybrid-card.js`
   - Type: JavaScript Module
3. Reload Home Assistant (hard browser reload)

## Configuration

The card can be set up via the visual editor (Add Card -> search for "SoundTouch Hybrid Card"), or via YAML:

```yaml
type: custom:soundtouch-hybrid-card
bose_url: /api/hassio_ingress/YOUR-BOSE-INGRESS-TOKEN
mass_url: /api/hassio_ingress/YOUR-MASS-INGRESS-TOKEN
speakers:
  Kitchen: media_player.kitchen_speaker
  Living Room: media_player.living_room
```

| Option      | Required | Description                                                                                                                                      |
| ----------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bose_url`  |    Yes   | Ingress path of the Bose SoundTouch Hybrid add-on, or a full external URL (e.g. `http://192.168.1.50:8080`), if the add-on isn't reachable via HA ingress |
| `mass_url`  |    No    | Ingress path or external URL of Music Assistant. Only needed if you want to use the favorite button                                                |
| `speakers`  |    No    | Maps the speaker names from the Bose app to the matching Home Assistant `media_player` entities. Only needed for the favorite button              |

### Finding the ingress path

1. Open the respective add-on via **Settings -> Add-ons -> [add-on name] -> Open Web UI**
2. Open the browser developer tools (F12) -> Network tab
3. Look for a request whose URL contains `/api/hassio_ingress/<TOKEN>/...` -- the part up to the token is your `bose_url`/`mass_url`

**Important:** The add-on must have been opened at least once this way, so Home Assistant establishes the required ingress session.

### External URLs instead of ingress

If Bose SoundTouch Hybrid or Music Assistant don't run behind HA ingress (e.g. on a different server), you can enter the full external address instead (e.g. `http://192.168.1.50:8080`). In that case, the respective server must allow CORS requests from your Home Assistant domain.

In practice, both Bose SoundTouch Hybrid and Music Assistant commonly allow CORS requests from any origin by default, so this usually works out of the box even when both run on the same host as Home Assistant (just on different ports, which technically counts as a different origin). If your setup has been configured with stricter CORS rules, you may need to explicitly allow your Home Assistant domain on the respective server, or fall back to using ingress paths instead.

## Features

- Power, play/pause, previous/next track control
- Volume slider (including group volume for multiroom groups)
- Presets with cover thumbnails, including the extended double-tap preset row (11-66) if enabled in the app
- Sync/group with other speakers
- State icons for standby, Bluetooth, and AUX
- Favorite button (adds the currently playing song to Deezer/Spotify/etc. favorites via Music Assistant)
- Square card layout, fitting nicely into the Sections dashboard grid
- Visual editor for configuration

## License

MIT
