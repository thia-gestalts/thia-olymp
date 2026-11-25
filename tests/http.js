// Node creates a full-duplex Unix socket pair for the child's stdin. This is
// real HTTP/1.1, including binary request bodies and HTTP status handling.
import http from "node:http";
export function connectedFetch(socket) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = () => socket;
  return (url, { method, headers, body, signal } = {}) =>
    new Promise((ok, fail) => {
      const req = http.request(
        url,
        { method, headers, signal, agent },
        (res) => {
          const chunks = [];
          res.on("data", (part) => chunks.push(part));
          res.on("error", fail);
          res.on("end", () =>
            ok(
              new Response(
                res.statusCode === 204 ? null : Buffer.concat(chunks),
                { status: res.statusCode, headers: res.headers },
              ),
            ),
          );
        },
      );
      req.on("error", fail);
      req.end(body);
    });
}
