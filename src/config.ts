import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type Config = {
  origin?: string;
  home?: string;
  work?: string;
  timezone?: string;
};

export function getConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "sl-cli", "config.json");
}

export function readConfig(): Config {
  const filePath = getConfigPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function writeConfig(config: Config): void {
  const filePath = getConfigPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

export function resolveOrigin(cliValue?: string): string | undefined {
  if (cliValue && cliValue.trim()) {
    return cliValue.trim();
  }
  if (process.env.SLCLI_ORIGIN && process.env.SLCLI_ORIGIN.trim()) {
    return process.env.SLCLI_ORIGIN.trim();
  }
  const config = readConfig();
  if (config.origin && config.origin.trim()) {
    return config.origin.trim();
  }
  return undefined;
}

export const CONFIG_KEYS = ["origin", "home", "work", "timezone"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
