import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CdpConnection,
  launchChrome,
  stopChrome,
} from "./chrome-harness.mjs";

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #exitOn: NodeJS.Signals | undefined;

  constructor(exitOn: NodeJS.Signals | undefined = "SIGTERM") {
    super();
    this.#exitOn = exitOn;
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === this.#exitOn) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closed = false;

  constructor(_url: string, { open = true } = {}) {
    super();
    FakeWebSocket.instances.push(this);
    if (open) queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

describe("Chrome browser harness lifecycle", () => {
  it("rejects an invalid explicit CHROME_PATH before allocating resources", async () => {
    let profileCreated = false;
    let childSpawned = false;

    await expect(
      launchChrome({
        chromePath: "/missing/chrome",
        dependencies: {
          exists: () => false,
          createProfile: async () => {
            profileCreated = true;
            return "/tmp/unused-profile";
          },
          spawnChrome: () => {
            childSpawned = true;
            return new FakeChild();
          },
        },
      }),
    ).rejects.toThrow("CHROME_PATH does not point to an executable");
    expect(profileCreated).toBe(false);
    expect(childSpawned).toBe(false);
  });

  it("cleans the child and profile after a forced startup timeout", async () => {
    const child = new FakeChild();
    const removed: string[] = [];

    await expect(
      launchChrome({
        chromePath: "/fake/chrome",
        startupTimeoutMs: 5,
        cleanupGraceMs: 5,
        dependencies: {
          exists: () => true,
          createProfile: async () => "/tmp/startup-timeout-profile",
          removeProfile: async (path: string) => {
            removed.push(path);
          },
          spawnChrome: () => child,
        },
      }),
    ).rejects.toThrow("did not expose a DevTools endpoint");
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(removed).toEqual(["/tmp/startup-timeout-profile"]);
  });

  it("cleans the profile without waiting on a child that failed to spawn", async () => {
    const child = new FakeChild("SIGKILL");
    const removed: string[] = [];

    await expect(
      launchChrome({
        chromePath: "/fake/chrome",
        startupTimeoutMs: 50,
        cleanupGraceMs: 5,
        dependencies: {
          exists: () => true,
          createProfile: async () => "/tmp/spawn-error-profile",
          removeProfile: async (path: string) => {
            removed.push(path);
          },
          spawnChrome: () => {
            queueMicrotask(() => child.emit("error", new Error("spawn denied")));
            return child;
          },
        },
      }),
    ).rejects.toThrow("Chrome failed to start: spawn denied");
    expect(child.signals).toEqual([]);
    expect(removed).toEqual(["/tmp/spawn-error-profile"]);
  });

  it("cleans the child and profile after a forced connect timeout", async () => {
    const child = new FakeChild();
    const removed: string[] = [];

    queueMicrotask(() => {
      child.stderr.write("DevTools listening on ws://127.0.0.1/devtools/browser/test\n");
    });
    await expect(
      launchChrome({
        chromePath: "/fake/chrome",
        connectTimeoutMs: 5,
        cleanupGraceMs: 5,
        dependencies: {
          exists: () => true,
          createProfile: async () => "/tmp/connect-timeout-profile",
          removeProfile: async (path: string) => {
            removed.push(path);
          },
          spawnChrome: () => child,
          connect: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("Chrome DevTools connection timed out");
          },
        },
      }),
    ).rejects.toThrow("connection timed out");
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(removed).toEqual(["/tmp/connect-timeout-profile"]);
  });

  it("bounds WebSocket connect and command waits and rejects pending work on close", async () => {
    FakeWebSocket.instances = [];
    await expect(
      CdpConnection.connect("ws://never-opens", {
        timeoutMs: 5,
        WebSocketClass: class extends FakeWebSocket {
          constructor(url: string) {
            super(url, { open: false });
          }
        },
      }),
    ).rejects.toThrow("connection timed out");
    expect(FakeWebSocket.instances[0].closed).toBe(true);

    const connection = await CdpConnection.connect("ws://opens", {
      timeoutMs: 20,
      commandTimeoutMs: 5,
      WebSocketClass: FakeWebSocket,
    });
    await expect(connection.send("Never.responds")).rejects.toThrow(
      "CDP command timed out: Never.responds",
    );
    const pending = connection.send("Still.pending", {}, undefined, 1_000);
    connection.close();
    await expect(pending).rejects.toThrow("CDP connection closed");
    expect(connection.socket.closed).toBe(true);

    const failedConnection = await CdpConnection.connect("ws://fails-later", {
      timeoutMs: 20,
      commandTimeoutMs: 1_000,
      WebSocketClass: FakeWebSocket,
    });
    const failedPending = failedConnection.send("Fails.with.socket", {});
    failedConnection.socket.dispatchEvent(new Event("error"));
    await expect(failedPending).rejects.toThrow("CDP connection failed");
    expect(failedConnection.socket.closed).toBe(true);
  });

  it("escalates teardown to SIGKILL and waits for exit before removing the profile", async () => {
    const child = new FakeChild("SIGKILL");
    const events: string[] = [];
    child.on("exit", () => events.push("exit"));

    await stopChrome(
      {
        child,
        connection: { close: () => events.push("socket-closed") },
        userDataDirectory: "/tmp/forced-kill-profile",
      },
      {
        graceMs: 5,
        removeProfile: async () => {
          events.push("profile-removed");
        },
      },
    );

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(events).toEqual(["socket-closed", "exit", "profile-removed"]);
  });
});
