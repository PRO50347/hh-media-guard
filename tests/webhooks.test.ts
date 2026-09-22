import { describe, it, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { rotateWebhookToken, receiveWebhook } from "../src/lib/webhooks";
import { raw, addMapping, listScans, jobQueue } from "../src/lib/store";
import { executeJob } from "../src/lib/worker";
import { runProcess } from "../src/lib/process";
const token = rotateWebhookToken("radarr");
const event = {
  eventType: "Download",
  movie: { id: 123 },
  movieFile: { id: 456, path: "/arr-movies/test.mka" },
  downloadId: "generated-fixture",
};
const request = (data: unknown, credential = token) =>
  new Request("http://fixture.test/api/webhooks/radarr", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(data),
  });
describe("authenticated import processing", () => {
  it("rejects invalid authentication before creating a job", async () => {
    expect(
      (await receiveWebhook("radarr", request(event, "invalid"))).status,
    ).toBe(401);
    expect(jobQueue.list()).toHaveLength(0);
  });
  it("does not accept one integration token for the other", async () => {
    expect((await receiveWebhook("sonarr", request(event))).status).toBe(401);
  });
  it("accepts the native connection test without queueing", async () => {
    expect(
      await (
        await receiveWebhook("radarr", request({ eventType: "Test" }))
      ).json(),
    ).toEqual({ accepted: true, test: true });
    expect(jobQueue.list()).toHaveLength(0);
  });
  it("rejects unsupported events, missing identity, and traversal", async () => {
    for (const data of [
      { eventType: "Grab" },
      { ...event, movie: undefined },
      { ...event, movieFile: { id: 456, path: "/arr-movies/../secret" } },
    ])
      expect((await receiveWebhook("radarr", request(data))).status).toBe(400);
  });
  it("queues once, rejects reordered replays, and persists actual ffprobe evidence", async () => {
    const root = path.join(process.env.CONFIG_DIR!, "webhook-fixtures");
    await mkdir(root);
    const file = path.join(root, "test.mka");
    await runProcess("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-metadata:s:a:0",
      "language=eng",
      "-c:a",
      "flac",
      file,
    ]);
    addMapping({
      source: "radarr",
      arrPath: "/arr-movies",
      containerPath: root,
      mediaType: "movies",
      enabled: true,
    });
    const first = await (await receiveWebhook("radarr", request(event))).json();
    expect(first.queued).toBe(true);
    const replay = await (
      await receiveWebhook(
        "radarr",
        request({
          movieFile: event.movieFile,
          movie: event.movie,
          downloadId: event.downloadId,
          eventType: event.eventType,
        }),
      )
    ).json();
    expect(replay.deduplicated).toBe(true);
    expect(jobQueue.list()).toHaveLength(1);
    const job = jobQueue.claim()!;
    await executeJob(job, new AbortController().signal);
    jobQueue.finish(job, "completed");
    expect(listScans()[0]).toMatchObject({ path: file, decision: "pass" });
    expect(
      JSON.stringify(raw().prepare("SELECT * FROM events").all()),
    ).not.toContain(token);
    expect(
      JSON.stringify(raw().prepare("SELECT * FROM webhook_tokens").all()),
    ).not.toContain(token);
  });
  it("revokes old credentials on rotation", async () => {
    rotateWebhookToken("radarr");
    expect((await receiveWebhook("radarr", request(event))).status).toBe(401);
  });
});
