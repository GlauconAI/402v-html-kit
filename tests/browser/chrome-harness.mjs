import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME_CANDIDATES = Object.freeze([
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_GRACE_MS = 5_000;
const FAILED_TO_SPAWN = new WeakSet();

function rejectPending(pending, error) {
  for (const command of pending.values()) {
    clearTimeout(command.timeout);
    command.reject(error);
  }
  pending.clear();
}

export class CdpConnection {
  #id = 0;
  #pending = new Map();
  #eventHandlers = new Set();
  #commandTimeoutMs;
  #closed = false;

  constructor(socket, { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.id !== undefined) {
        const pending = this.#pending.get(payload.id);
        if (pending === undefined) return;
        this.#pending.delete(payload.id);
        clearTimeout(pending.timeout);
        if (payload.error !== undefined) {
          pending.reject(new Error(payload.error.message ?? "CDP command failed"));
        } else {
          pending.resolve(payload.result ?? {});
        }
        return;
      }
      for (const handler of this.#eventHandlers) handler(payload);
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      rejectPending(this.#pending, new Error("CDP connection closed"));
    });
    socket.addEventListener("error", () => {
      this.#closed = true;
      rejectPending(this.#pending, new Error("CDP connection failed"));
      try {
        socket.close();
      } catch {}
    });
  }

  /**
   * @param {string} url
   * @param {{
   *   timeoutMs?: number,
   *   commandTimeoutMs?: number,
   *   WebSocketClass?: new (url: string) => any,
   * }} [options]
   */
  static connect(
    url,
    {
      timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
      commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
      WebSocketClass = globalThis.WebSocket,
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocketClass !== "function") {
        reject(new Error("A WebSocket implementation is required for Chrome DevTools"));
        return;
      }
      let socket;
      try {
        socket = new WebSocketClass(url);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        callback();
      };
      const onOpen = () =>
        finish(() => resolve(new CdpConnection(socket, { commandTimeoutMs })));
      const fail = (message) =>
        finish(() => {
          try {
            socket.close();
          } catch {}
          reject(new Error(message));
        });
      const onError = () => fail(`Unable to connect to Chrome DevTools at ${url}`);
      const onClose = () => fail(`Chrome DevTools connection closed before opening at ${url}`);
      const timeout = setTimeout(
        () => fail(`Chrome DevTools connection timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  /**
   * @param {(event: {
   *   method: string,
   *   params?: Record<string, unknown>,
   *   sessionId?: string,
   * }) => void} handler
   */
  onEvent(handler) {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  send(
    method,
    params = {},
    sessionId = undefined,
    timeoutMs = this.#commandTimeoutMs,
  ) {
    if (this.#closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    rejectPending(this.#pending, new Error("CDP connection closed"));
    try {
      this.socket.close();
    } catch {}
  }
}

function resolveChromeExecutable(chromePath, exists) {
  if (chromePath !== undefined && chromePath !== "") {
    if (!exists(chromePath)) {
      throw new Error(`CHROME_PATH does not point to an executable: ${chromePath}`);
    }
    return chromePath;
  }
  const executable = DEFAULT_CHROME_CANDIDATES.find((candidate) => exists(candidate));
  if (executable === undefined) {
    throw new Error(
      `A real Chrome/Chromium executable is required; checked: ${DEFAULT_CHROME_CANDIDATES.join(", ")}`,
    );
  }
  return executable;
}

function waitForEndpoint(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stderr?.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      callback();
    };
    const onData = (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match !== null) finish(() => resolve(match[1]));
    };
    const onError = (error) => {
      FAILED_TO_SPAWN.add(child);
      finish(() => reject(new Error(`Chrome failed to start: ${error.message}`)));
    };
    const onExit = (code, signal) =>
      finish(() =>
        reject(
          new Error(
            `Chrome exited before startup (code ${code}, signal ${signal}): ${stderr}`,
          ),
        ),
      );
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Chrome did not expose a DevTools endpoint within ${timeoutMs}ms`,
            ),
          ),
        ),
      timeoutMs,
    );
    if (child.stderr === null || child.stderr === undefined) {
      finish(() => reject(new Error("Chrome stderr pipe is unavailable")));
      return;
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function childExited(child) {
  return (
    FAILED_TO_SPAWN.has(child) ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

function waitForExit(child) {
  if (childExited(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function waitForExitWithin(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child, graceMs) {
  if (childExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForExitWithin(child, graceMs)) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}

function defaultDependencies() {
  return {
    exists: existsSync,
    createProfile: () => mkdtemp(join(tmpdir(), "402v-theme-browser-")),
    removeProfile: (path) => rm(path, { recursive: true, force: true }),
    spawnChrome: (executable, args) =>
      spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] }),
    connect: (endpoint, options) => CdpConnection.connect(endpoint, options),
  };
}

export async function stopChrome(
  browser,
  {
    graceMs = DEFAULT_CLEANUP_GRACE_MS,
    removeProfile = defaultDependencies().removeProfile,
  } = {},
) {
  try {
    browser.connection?.close();
  } finally {
    try {
      await terminateChild(browser.child, graceMs);
    } finally {
      await removeProfile(browser.userDataDirectory);
    }
  }
}

export async function launchChrome({
  chromePath = process.env.CHROME_PATH,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  cleanupGraceMs = DEFAULT_CLEANUP_GRACE_MS,
  dependencies = {},
} = {}) {
  const lifecycle = { ...defaultDependencies(), ...dependencies };
  const executable = resolveChromeExecutable(chromePath, lifecycle.exists);
  const userDataDirectory = await lifecycle.createProfile();
  let child;
  let connection;
  try {
    child = lifecycle.spawnChrome(executable, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--password-store=basic",
      "--use-mock-keychain",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDirectory}`,
      "about:blank",
    ]);
    const endpoint = await waitForEndpoint(child, startupTimeoutMs);
    connection = await lifecycle.connect(endpoint, {
      timeoutMs: connectTimeoutMs,
      commandTimeoutMs,
    });
    return { child, connection, userDataDirectory };
  } catch (error) {
    if (child === undefined) {
      await lifecycle.removeProfile(userDataDirectory);
    } else {
      await stopChrome(
        { child, connection, userDataDirectory },
        { graceMs: cleanupGraceMs, removeProfile: lifecycle.removeProfile },
      );
    }
    throw error;
  }
}
