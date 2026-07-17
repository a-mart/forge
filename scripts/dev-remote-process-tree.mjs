import { spawn } from "node:child_process";

export function terminateDevChild(
  child,
  {
    platform = process.platform,
    signal = "SIGINT",
    spawnProcess = spawn,
    killProcess = process.kill,
    onError = () => {},
  } = {},
) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }

  try {
    if (platform === "win32") {
      // Node emulates signals on Windows by terminating only the immediate process.
      // Kill the cmd.exe wrapper and its descendants together before the wrapper PID disappears.
      const taskkill = spawnProcess(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      taskkill.on?.("error", onError);
    } else {
      killProcess(-child.pid, signal);
    }
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") {
      onError(error);
    }
    return false;
  }
}
