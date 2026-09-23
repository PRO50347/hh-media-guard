import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ default: { request: mocks.request } }));
import { arrTransport } from "../src/lib/arr-transport";
beforeEach(() => vi.resetAllMocks());
it("rejects mixed DNS answers before sending credentials", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "192.168.1.20", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await expect(
    arrTransport(new URL("http://fixture.test"), "fixture-secret", "GET"),
  ).rejects.toThrow("prohibited");
  expect(mocks.request).not.toHaveBeenCalled();
});
it("pins the validated DNS address and refuses redirects without a second request", async () => {
  mocks.lookup.mockResolvedValue([{ address: "192.168.1.20", family: 4 }]);
  mocks.request.mockImplementation((_url, options, respond) => {
    const pinned = vi.fn();
    options.lookup("fixture.test", { all: true }, pinned);
    expect(pinned).toHaveBeenCalledWith(null, [
      { address: "192.168.1.20", family: 4 },
    ]);
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 302,
        headers: { location: "http://127.0.0.1/" },
      });
      respond(response);
      response.emit("end");
      request.emit("close");
    };
    return request;
  });
  await expect(
    arrTransport(new URL("http://fixture.test"), "fixture-secret", "GET"),
  ).rejects.toThrow("HTTP 302");
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it("does not expose untrusted response bodies in errors", async () => {
  mocks.lookup.mockResolvedValue([{ address: "192.168.1.20", family: 4 }]);
  mocks.request.mockImplementation((_url, _options, respond) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 401 });
      respond(response);
      response.emit("data", Buffer.from("fixture-secret"));
      response.emit("end");
      request.emit("close");
    };
    return request;
  });
  await expect(
    arrTransport(new URL("http://fixture.test"), "fixture-secret", "GET"),
  ).rejects.toThrow(/^Arr request failed with HTTP 401$/);
});
