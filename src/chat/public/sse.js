// A `fetch()` + stream-reader based SSE client, used instead of the browser's native
// `EventSource`.
//
// EventSource is a GET request with its own caching/reconnection semantics that some
// reverse proxies and tunnels (Cloudflare Tunnel among them) buffer or interfere with
// differently than a plain streamed fetch response — which is exactly how /api/chat's
// POST-based stream already works reliably through the same tunnel. This gives the two
// remaining SSE consumers (traces, audit log) the same proven transport instead of a
// second, less reliable one.

/**
 * Connects to an SSE endpoint via fetch and calls `onData` with each event's raw
 * `data:` payload (a string, same as `event.data` on a native EventSource message).
 * Reconnects automatically on disconnect or error, mirroring EventSource's own
 * behavior, since a plain fetch stream has none of that built in.
 */
export function connectSSE(url, onData) {
  let stopped = false;

  async function run() {
    while (!stopped) {
      try {
        const response = await fetch(url);
        if (!response.ok || !response.body) throw new Error(`SSE ${url}: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const dataLines = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""));
            if (dataLines.length === 0) continue; // comment/heartbeat-only frame
            onData(dataLines.join("\n"));
          }
        }
      } catch {
        // Connection dropped or never opened — fall through to the reconnect delay
        // below, same as EventSource would do on its own.
      }

      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  void run();

  return () => {
    stopped = true;
  };
}
