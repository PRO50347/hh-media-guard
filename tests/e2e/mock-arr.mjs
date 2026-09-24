import http from "node:http";
const requests = [];
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/__requests") {
      res.end(JSON.stringify(requests));
      return;
    }
    requests.push({ method: req.method, path: url.pathname });
    if (req.headers["x-api-key"] !== "fixture-api-key") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const service = url.pathname.startsWith("/sonarr/") ? "Sonarr" : "Radarr";
    url.pathname = url.pathname.replace(/^\/(sonarr|radarr)/, "");
    const routes = {
      "/api/v3/system/status": {
        version: "4.0.0",
        appName: service,
      },
      "/api/v3/movie": [
        { id: 1, title: "Generated English Movie", year: 2026, hasFile: true },
        { id: 2, title: "Generated Spanish Movie", year: 2026, hasFile: true },
      ],
      "/api/v3/series": [
        { id: 10, title: "Generated Series", path: "/arr/tv" },
      ],
      "/api/v3/episode": [
        {
          id: 11,
          seriesId: 10,
          episodeFileId: 111,
          seasonNumber: 1,
          episodeNumber: 1,
          title: "Generated Pilot",
        },
      ],
      "/api/v3/episodefile": [
        { id: 111, seriesId: 10, path: "/arr/tv/pilot.mka" },
      ],
      "/api/v3/config/downloadclient": { autoRedownloadFailed: false },
      "/api/v3/history": { records: [], totalRecords: 0 },
    };
    const single = url.pathname.match(/^\/api\/v3\/(movie|series)\/(\d+)$/);
    if (single) {
      const record = routes[`/api/v3/${single[1]}`].find(
        (item) => item.id === Number(single[2]),
      );
      if (!record) res.writeHead(404);
      res.end(JSON.stringify(record || {}));
      return;
    }
    if (url.pathname === "/api/v3/moviefile") {
      const id = Number(url.searchParams.get("movieId"));
      res.end(
        JSON.stringify([
          {
            id: id + 100,
            movieId: id,
            path: `/arr/movies/${id === 1 ? "english" : "spanish"}.mka`,
          },
        ]),
      );
      return;
    }
    if (routes[url.pathname] !== undefined) {
      res.end(JSON.stringify(routes[url.pathname]));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  })
  .listen(8989, "0.0.0.0");
