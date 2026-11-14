// Local server PID identity: stable across clock steps, still rejects a reused PID.
import { describe, expect, it } from "vitest";
import {
  LINUX_IDENTITY_PREFIX,
  linuxProcessIdentity,
  procExited,
  procStartTicks,
  sameProcess,
} from "../../src/host/local";

// Fields 3..21 then starttime (field 22) = 777123, then the rest. The command name contains ") " on purpose.
const stat = (comm: string, start = "777123", state = "S") =>
  `4242 (${comm}) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${start} 1000000 200 18446744073709551615\n`;

const fakeProc =
  (files: Record<string, string>) =>
  (path: string): string => {
    const content = files[path];
    if (content === undefined)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return content;
  };

const BOOT = "/proc/sys/kernel/random/boot_id";

describe("procStartTicks", () => {
  it("reads field 22 even when the command name contains spaces and parentheses", () => {
    expect(procStartTicks(stat("bun"))).toBe("777123");
    expect(procStartTicks(stat("weird) name"))).toBe("777123");
  });

  it("rejects malformed input", () => {
    expect(procStartTicks("garbage")).toBeNull();
    expect(procStartTicks("1 (x) S 2 3")).toBeNull();
  });
});

describe("linuxProcessIdentity", () => {
  const cmdline = "/root/.bun/bin/bun\0/root/code/Folie/src/server/main.ts\0";

  it("combines boot id, start ticks and the command line", () => {
    const read = fakeProc({
      [BOOT]: "1b2c3d4e-0000-4000-8000-000000000001\n",
      "/proc/4242/stat": stat("bun"),
      "/proc/4242/cmdline": cmdline,
    });
    expect(linuxProcessIdentity(4242, read)).toBe(
      `${LINUX_IDENTITY_PREFIX}1b2c3d4e-0000-4000-8000-000000000001:777123 /root/.bun/bin/bun /root/code/Folie/src/server/main.ts`,
    );
  });

  it("treats an exited process awaiting reaping as gone, not as a different process", () => {
    // `folie down` polls while the server shuts down: a zombie keeps its PID but has an empty command line.
    expect(procExited(stat("bun", "777123", "Z"))).toBe(true);
    expect(procExited(stat("bun", "777123", "X"))).toBe(true);
    expect(procExited(stat("weird) name", "777123", "S"))).toBe(false);
    const read = fakeProc({
      [BOOT]: "b\n",
      "/proc/4242/stat": stat("bun", "777123", "Z"),
      "/proc/4242/cmdline": "",
    });
    expect(linuxProcessIdentity(4242, read)).toBeNull();
  });

  it("returns null for a process that does not exist, and undefined when /proc cannot answer", () => {
    expect(linuxProcessIdentity(4242, fakeProc({ [BOOT]: "b\n" }))).toBeNull();
    expect(linuxProcessIdentity(4242, fakeProc({}))).toBeUndefined();
    const denied = (path: string): string => {
      if (path === BOOT) return "b\n";
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(linuxProcessIdentity(4242, denied)).toBeUndefined();
  });

  it.runIf(process.platform === "linux")(
    "is stable for a live process across repeated reads",
    () => {
      const first = linuxProcessIdentity(process.pid);
      expect(first).toMatch(new RegExp(`^${LINUX_IDENTITY_PREFIX}[0-9a-f-]+:\\d+ \\S`));
      expect(linuxProcessIdentity(process.pid)).toBe(first);
    },
  );
});

describe("sameProcess", () => {
  const command = "/root/.bun/bin/bun /root/code/Folie/src/server/main.ts";
  const current = `${LINUX_IDENTITY_PREFIX}boot-1:777123 ${command}`;

  it("matches an identical identity", () => {
    expect(sameProcess(current, current)).toBe(true);
  });

  it("rejects a reused PID: same command, different start ticks or boot", () => {
    expect(sameProcess(`${LINUX_IDENTITY_PREFIX}boot-1:999999 ${command}`, current)).toBe(false);
    expect(sameProcess(`${LINUX_IDENTITY_PREFIX}boot-2:777123 ${command}`, current)).toBe(false);
  });

  it("accepts a record in the old ps format whose clock-based start time has drifted", () => {
    // Recorded at 10:07:33; after a WSL clock re-sync ps reported 10:07:27 for the same process.
    expect(sameProcess(`Sat Nov 14 10:07:33 2026 ${command}`, current)).toBe(true);
  });

  it("rejects an old-format record for a different command", () => {
    expect(sameProcess("Sat Nov 14 10:07:33 2026 /usr/bin/python3 other.py", current)).toBe(false);
  });

  it("keeps exact matching where /proc is not used (macOS, Windows)", () => {
    expect(sameProcess(`Sat Nov 14 10:07:33 2026 ${command}`, `Sat Nov 14 10:07:27 2026 ${command}`)).toBe(false);
  });
});
