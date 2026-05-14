export function getClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim()
    ?? "unknown";
}
