const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function isValidYoutubeVideoId(value: string) {
  return YOUTUBE_ID_REGEX.test(value.trim());
}

export function parseYoutubeVideoId(rawUrl: string) {
  const value = rawUrl.trim();
  if (!value) {
    throw new Error("YouTube URL is required.");
  }

  if (isValidYoutubeVideoId(value)) {
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid YouTube URL.");
  }

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtu.be") {
    throw new Error("Only YouTube URLs are supported.");
  }

  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    if (!isValidYoutubeVideoId(id)) {
      throw new Error("Unable to parse YouTube video id.");
    }
    return id;
  }

  if (parsed.pathname === "/watch") {
    const id = parsed.searchParams.get("v")?.trim() ?? "";
    if (!isValidYoutubeVideoId(id)) {
      throw new Error("Unable to parse YouTube video id.");
    }
    return id;
  }

  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "shorts" || pathParts[0] === "embed" || pathParts[0] === "live") {
    const id = pathParts[1] ?? "";
    if (!isValidYoutubeVideoId(id)) {
      throw new Error("Unable to parse YouTube video id.");
    }
    return id;
  }

  throw new Error("Unable to parse YouTube video id.");
}

export function buildCanonicalYoutubeUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
