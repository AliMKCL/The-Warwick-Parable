# server/

Optional Node process, added when needed:

- a proxy for a cloud model, so API keys never reach the browser;
- the director sidecar that runs `core/` for a Godot build, over a WebSocket.

Not used in Phase 1.
