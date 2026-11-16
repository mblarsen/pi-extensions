---
"@mblarsen/pi-footer-manager": patch
---

Reuse cached session statistics during unchanged footer repaints to reduce CPU use in long sessions. Keep statistics fresh when the session, active branch, model, or subscription changes, and keep git branch and extension status updates live.
