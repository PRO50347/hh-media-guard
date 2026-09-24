// Contract fixtures: distinct Sonarr/Radarr API v3 services, real HTTP and TLS.
// Request logs deliberately exclude headers, bodies and query strings.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
const handler = (service) => (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const pathname = url.pathname.replace(/^\/base/, "");
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (pathname === "/timeout/api/v3/system/status")
    return setTimeout(() => reply(200, {}), 9500);
  if (pathname === "/forbidden/api/v3/system/status")
    return reply(403, { error: "upstream secret must never be returned" });
  if (pathname === "/unexpected/api/v3/system/status")
    return reply(200, { version: "4.0.0" });
  if (pathname === "/html/api/v3/system/status") {
    res.end("<html>login</html>");
    return;
  }
  if (req.headers["x-api-key"] !== `fixture-${service.toLowerCase()}-key`)
    return reply(401, { error: "rejected secret must never be returned" });
  const library =
    service === "Sonarr"
      ? {
          "/api/v3/series": [{ id: 10, title: "Wizard Show", path: "/arr/tv" }],
          "/api/v3/episode": [
            {
              id: 11,
              seriesId: 10,
              episodeFileId: 111,
              seasonNumber: 1,
              episodeNumber: 1,
              title: "Wizard Episode",
            },
          ],
          "/api/v3/episodefile": [
            {
              id: 111,
              seriesId: 10,
              path: "/arr/tv/sonarr.mka",
              languages: [{ id: 1, name: "English" }],
            },
          ],
        }
      : {
          "/api/v3/movie": [
            { id: 1, title: "Wizard Movie", hasFile: true, year: 2026 },
          ],
          "/api/v3/moviefile": [
            {
              id: 101,
              movieId: 1,
              path: "/arr/movies/radarr.mka",
              languages: [{ id: 1, name: "English" }],
            },
          ],
        };
  const single = pathname.match(/^\/api\/v3\/(movie|series)\/(\d+)$/);
  if (single) {
    const record = library[`/api/v3/${single[1]}`]?.find(
      (item) => item.id === Number(single[2]),
    );
    return reply(record ? 200 : 404, record || {});
  }
  if (library[pathname]) return reply(200, library[pathname]);
  if (pathname !== "/api/v3/system/status") return reply(404, {});
  reply(200, {
    appName: service,
    instanceName: service,
    version: service === "Sonarr" ? "4.0.16.2944" : "5.28.0.10283",
    buildTime: "2026-01-01T00:00:00Z",
    isDebug: false,
    isProduction: true,
    isAdmin: false,
    isUserInteractive: false,
    startupPath: "/app",
    appData: "/config",
    osName: "alpine",
    isLinux: true,
    authentication: "forms",
    sqliteVersion: "3.46.1",
    urlBase: "",
  });
};
http.createServer(handler("Sonarr")).listen(8989, "0.0.0.0");
http.createServer(handler("Radarr")).listen(7878, "0.0.0.0");
if (process.env.FIXTURE_TLS)
  https
    .createServer(
      {
        key: fs.readFileSync("/tls/key.pem"),
        cert: fs.readFileSync("/tls/cert.pem"),
      },
      handler("Sonarr"),
    )
    .listen(9898, "0.0.0.0");
if (process.env.FIXTURE_TLS) {
  const options = {
    key: fs.readFileSync("/tls/trusted-key.pem"),
    cert: fs.readFileSync("/tls/trusted-cert.pem"),
  };
  https.createServer(options, handler("Sonarr")).listen(9899, "0.0.0.0");
  https.createServer(options, handler("Radarr")).listen(9999, "0.0.0.0");
}
