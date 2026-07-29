# burn-more-tokens

Shows a random completion message when a Pi agent run ends successfully.

The extension first sends a lowercase scrolling notification to an AWTRIX display. If the display is unavailable or rejects the request, macOS `say` is used as the fallback. Notification failures never interrupt Pi.

## Configuration

The default display is `http://192.168.100.159`. Override it with:

```bash
export AWTRIX_URL=http://awtrix.local
```

Set `AWTRIX_URL` to an empty string to disable display attempts and always use the `say` fallback.

AWTRIX completion messages remain active at all hours. Only the macOS `say` fallback is disabled during quiet hours from 20:00 until 08:00. Use `/say toggle` to override speech for the current Pi process.

## Commands

- `/say now` — show a random message immediately, falling back to speech.
- `/say toggle` — enable or disable the spoken fallback for the current process.

The AWTRIX request contains no sound fields and uses a five-second, single-pass scrolling notification.
