import fs from "fs/promises";
import type { SourceConfig } from "./types.js";

/**
 * Convenience loader for reading a JSON array of SourceConfig from a file.
 * Optional — a consumer can equally build the config array however it likes
 * (inline, from a DB, etc.) and pass it straight to startTerminal({ sources }).
 */
export async function loadSourceConfigs(filePath: string): Promise<SourceConfig[]> {
  const data = await fs.readFile(filePath, "utf-8");
  return JSON.parse(data);
}
