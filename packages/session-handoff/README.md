# session-handoff

Warn when a Pi session is expensive or stale enough to hand off.

The footer shows `handoff` after context usage exceeds 50,000 tokens and changes its severity after 100,000 tokens. It shows `likely expired` when the latest session message is more than 30 minutes old.

## Install

```bash
pi install npm:@mblarsen/pi-session-handoff
```

Run `/reload` or restart Pi after installation.
