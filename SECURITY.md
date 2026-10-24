# Security Policy

## Supported versions

Only the latest release receives security fixes. Please update through HACS before reporting an issue.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private reporting instead: go to the **Security** tab of this repository and choose **Report a vulnerability**. Include the card version, a description of the problem and, if possible, steps to reproduce it.

## Notes for users

- The card displays data supplied by the Bose SoundTouch Hybrid add-on and Music Assistant, such as track titles, artist names and artwork URLs. This data can originate from internet radio streams or Bluetooth/AUX sources and is treated as untrusted: text is escaped and only `http`, `https` and relative image URLs are used.
- The card stores no credentials. It only needs the URLs of your add-on and Music Assistant.
- If you use external URLs instead of Home Assistant ingress, the respective server has to allow requests from your Home Assistant domain (CORS). Only expose these servers inside your local network.
- Ingress paths in your card configuration contain a session-specific token. Remove it before pasting a configuration into a public issue.
