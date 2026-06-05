import { dotNsUrl } from "@dotli/shared/dotns-url";

export function parsePreviewTargetUrl(
  location: Pick<Location, "pathname" | "search">,
): string | null {
  if (location.pathname !== "/__preview") {
    return null;
  }

  const raw = new URLSearchParams(location.search).get("url");
  if (raw === null || raw === "") {
    return null;
  }

  try {
    const target = new URL(raw);
    const isLocalhost = dotNsUrl.parseLocalhostUrl(target.toString()) !== null;
    const isWebContainer =
      target.protocol === "https:" &&
      dotNsUrl.isWebcontainerPreviewHost(target.hostname);

    if (
      (!isLocalhost && !isWebContainer) ||
      target.username ||
      target.password
    ) {
      return null;
    }

    return target.toString();
  } catch {
    return null;
  }
}
