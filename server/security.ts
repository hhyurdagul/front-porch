export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /api[_-]?key|token|secret|authorization|credential|password/i.test(k)
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  if (typeof value === "string") {
    let s = value
      .replace(/(?:Bearer\s+)[^\s]+/gi, "[REDACTED]")
      .replace(/AIza[\w-]+/g, "[REDACTED]");
    for (const k of [process.env.QLOO_API_KEY, process.env.GEMINI_API_KEY])
      if (k) s = s.split(k).join("[REDACTED]");
    return s;
  }
  return value;
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public http = 400,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
  http = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, http);
}
