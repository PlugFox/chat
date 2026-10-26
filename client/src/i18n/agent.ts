/** "Chrome on macOS" from a user agent; product names are not translated. */
export function describeAgent(ua: string | null | undefined): { browser: string; os: string } | null {
  if (!ua) return null;
  const browser = [
    [/Edg\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Firefox\//, "Firefox"],
    [/Chrome\//, "Chrome"],
    [/Safari\//, "Safari"],
  ].find(([pattern]) => (pattern as RegExp).test(ua))?.[1] as string | undefined;
  const os = [
    [/Android/, "Android"],
    [/iPhone|iPad/, "iOS"],
    [/Mac OS X/, "macOS"],
    [/Windows/, "Windows"],
    [/CrOS/, "ChromeOS"],
    [/Linux/, "Linux"],
  ].find(([pattern]) => (pattern as RegExp).test(ua))?.[1] as string | undefined;
  return browser && os ? { browser, os } : null;
}
