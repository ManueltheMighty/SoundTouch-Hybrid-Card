# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.4]

### Changed
- The favorite button is now an outline heart that turns into a filled red heart once the song has been added to your favorites. The state is remembered per song and resets when the song changes.
- On touch screens, the volume and group-volume sliders only react when the thumb itself is dragged. Tapping or scrolling over the track no longer changes the volume by accident. Mouse and pen input work as before.

### Fixed
- The favorite button no longer shows a song as liked when Music Assistant rejects the request.
- The value bubble above the volume sliders now sits exactly above the thumb (it was shifted by the width of the label before).
- The volume and group-volume sliders no longer jump back to their old position while being dragged. Re-rendering is now paused during interaction, including updates triggered by unrelated Home Assistant entities.

## [1.1.3]

### Security
- Escape all backend-provided text (speaker name, track, artist) before rendering it, so crafted track metadata (internet radio, Bluetooth, AUX, streaming services) can no longer inject markup or script into the Home Assistant frontend.
- Validate artwork and preset image URLs: only `http`, `https` and relative URLs are accepted. Images are now assigned through DOM properties instead of string interpolation, and the inline `onerror` handler was replaced by `addEventListener`.
- Escape configuration values rendered in the visual editor.

## [1.1.2]

### Security
- Escape all backend-provided text (speaker name, track, artist) before rendering it, so crafted track metadata (internet radio, Bluetooth, AUX, streaming services) can no longer inject markup or script into the Home Assistant frontend.
- Validate artwork and preset image URLs: only `http`, `https` and relative URLs are accepted. Images are now assigned through DOM properties instead of string interpolation, and the inline `onerror` handler was replaced by `addEventListener`.
- Escape configuration values rendered in the visual editor.

## [1.1.0]

### Added
- Larger slider thumb and a floating value bubble while dragging the volume and group-volume sliders, which makes them easier to use on touch devices.

### Changed
- Sliders now use a custom style instead of the native range input appearance.

## [1.0.0]

### Added
- Initial release.
- Power, play/pause and previous/next track control.
- Volume slider, including group volume for multiroom groups.
- Presets with cover thumbnails, including the extended double-tap preset row (11–66) when enabled in the app.
- Sync/group with other speakers.
- State icons for standby, Bluetooth and AUX.
- Favorite button that adds the currently playing song to your streaming service favorites via Music Assistant.
- Square card layout for the Sections dashboard grid, with light and dark theme support.
- Visual editor for configuration.

[Unreleased]: https://github.com/ManueltheMighty/SoundTouch-Hybrid-Card/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ManueltheMighty/SoundTouch-Hybrid-Card/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ManueltheMighty/SoundTouch-Hybrid-Card/releases/tag/v1.0.0
