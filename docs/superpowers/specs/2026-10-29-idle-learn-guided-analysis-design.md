# Guided Idle Learn analysis

Approved scope: `/idle-learn analyze <guidance>` focuses the isolated reviewer on recent conversation, including previously reviewed entries. Plain `analyze` retains its unseen-entry behavior. The review screen's `a` action and menu's Analyze now ask for optional guidance: Enter starts ordinary analysis; Escape cancels.

Guided runs capture the latest contiguous suffix of the current session branch within the existing 48 KiB transcript budget. Tool results retain the existing bounded excerpts. No full-session scan or backlog continuation occurs. An oversized latest conversational entry produces the existing explicit size error. Guidance is limited to 8 KiB and sent separately from transcript evidence; it cannot override evidence validation, output limits, or write boundaries.

Guided runs save validated proposals and observations through existing short storage locks. They leave normal reviewed-entry checkpoints and instruction audit hashes unchanged. Proposals still require transcript quotes and use the normal batch review flow. Cancellation, model selection, and background lifecycle follow manual analysis.

Checks: newest evidence selection; checkpoint preservation; quoted evidence validation; normal backlog behavior; direct command guidance; optional menu and review-screen input including cancellation; full repository checks. No commit, publication, or installation.
