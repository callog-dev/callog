/** Minimal cookie helpers: the UI needs two cookies, not a cookie framework. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined; // malformed %-encoding: no such cookie, not a 500
      }
    }
  }
  return undefined;
}

/** A Set-Cookie that deletes `name`. */
export function clearCookie(name: string, secure: boolean): string {
  return cookie(name, "", { maxAgeSeconds: 0, secure });
}

export function cookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}
