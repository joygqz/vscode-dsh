/** Merge process environments with Windows' case-insensitive key semantics. */
export function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (platform === 'win32') {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(result)) {
        if (existing.toLowerCase() === lower) delete result[existing];
      }
    }
    result[key] = value;
  }
  return result;
}
