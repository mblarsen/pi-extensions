# burn-more-tokens

Shows a random completion message when a Pi agent run ends successfully.

The extension sends a lowercase scrolling notification to an AWTRIX display and also uses macOS `say` outside quiet hours. During quiet hours, only the display notification is sent. Notification failures never interrupt Pi.

## Install

```bash
pi install npm:@mblarsen/pi-burn-more-tokens
```

## Configuration

The default display is `http://192.168.100.159`. Override it with:

```bash
export AWTRIX_URL=http://awtrix.local
```

Set `AWTRIX_URL` to an empty string to disable display attempts without changing speech behavior.

AWTRIX completion messages remain active at all hours. macOS `say` is disabled during quiet hours from 20:00 until 08:00. Use `/say toggle` to override speech for the current Pi process.

## Commands

- `/say now` — show and speak a random message immediately.
- `/say toggle` — enable or disable speech for the current process; display notifications remain active.

The AWTRIX request contains no sound fields and uses a five-second, single-pass scrolling notification.
