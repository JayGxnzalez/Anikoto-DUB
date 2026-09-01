const ANIKOTO_BASE = "https://anikototv.to";
const MEGAPLAY = "https://megaplay.buzz";
const VIDWISH = "https://vidwish.live";
const VIDTUBE = "https://vidtube.site";
const ANILIST_API = "https://graphql.anilist.co";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ══════════════════════════════════════════════════════════════════
// AniList — search + episode-count lookup. Stable public API, no auth.
// ══════════════════════════════════════════════════════════════════
class AniList {
    static async search(keyword) {
        const query = `query($search: String) {
            Page(perPage: 15) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                    id
                    idMal
                    title { english romaji }
                    episodes
                    coverImage { large }
                }
            }
        }`;

        console.log("[AniList] Searching: " + keyword);
        const resp = await soraFetch(ANILIST_API, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ query, variables: { search: keyword } })
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") {
            console.error("[AniList] Search fetch failed, status: " + (resp ? resp.status : "null"));
            return [];
        }
        let json;
        try { json = await resp.json(); } catch (e) {
            console.error("[AniList] Search JSON parse failed: " + e);
            return [];
        }

        const media = json?.data?.Page?.media || [];
        // Titles without a MAL mapping can't be used by either resolution
        // path (primary is MAL-keyed, fallback needs a title to search
        // Anikoto by) — filter them out rather than surfacing dead entries.
        const items = media
            .filter(m => m.idMal)
            .map(m => ({
                anilistId: m.id,
                malId: m.idMal,
                title: m.title?.english || m.title?.romaji || "Untitled",
                episodes: m.episodes || null,
                poster: m.coverImage?.large || ""
            }));

        console.log("[AniList] Search returned " + items.length + " usable items");
        return items;
    }

    static async getDetails(anilistId) {
        const query = `query ($id: Int) {
            Media(id: $id, type: ANIME) {
                description(asHtml: false)
                episodes
                status
                averageScore
                genres
                season
                seasonYear
            }
        }`;

        console.log("[AniList] Fetching details for id: " + anilistId);
        const resp = await soraFetch(ANILIST_API, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ query, variables: { id: parseInt(anilistId, 10) } })
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") return null;
        let json;
        try { json = await resp.json(); } catch (e) { return null; }

        const media = json?.data?.Media;
        if (!media) return null;

        return {
            synopsis: (media.description || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+(>|$)/g, "").trim(),
            status: media.status || "",
            score: media.averageScore || "",
            genres: (media.genres || []).join(", "),
            season: media.season && media.seasonYear ? media.season + " " + media.seasonYear : ""
        };
    }
}

// ══════════════════════════════════════════════════════════════════
// Primary path — direct Megaplay lookup keyed by MAL ID.
// Bypasses Anikoto's own site and token system entirely.
// ══════════════════════════════════════════════════════════════════
async function tryMegaplayDirect(malId, epNum, audio) {
    const embedUrl = `${MEGAPLAY}/stream/mal/${malId}/${epNum}/${audio}`;
    console.log("[Direct] Trying Megaplay/MAL: " + embedUrl);

    const resp = await soraFetch(embedUrl, { headers: { "Referer": MEGAPLAY + "/", "User-Agent": UA } });
    if (!resp || resp.status !== 200) return null;
    const html = await resp.text();

    const fileId = html.match(/data-id="([^"]*)"/)?.[1];
    if (!fileId) {
        console.log("[Direct] No data-id — Megaplay has no MAL-keyed entry for this episode");
        return null;
    }
    const realId = html.match(/data-realid="([^"]*)"/)?.[1] || null;

    const [megaResult, vidwishResult] = await Promise.allSettled([
        fetchMegaplaySources(fileId),
        realId ? fetchVidwishSources(realId, audio) : Promise.resolve(null)
    ]);

    const streams = [];
    let subtitles = "", subtitlesHeaders = {}, allSubtitles = [];

    const mega = megaResult.status === "fulfilled" ? megaResult.value : null;
    if (mega) {
        streams.push({ title: "Megaplay", streamUrl: mega.streamUrl, headers: mega.headers });
        subtitles = mega.subtitles; subtitlesHeaders = mega.subtitlesHeaders;
        allSubtitles.push(...mega.allSubtitles);
    }

    const vidwish = vidwishResult.status === "fulfilled" ? vidwishResult.value : null;
    if (vidwish) {
        streams.push({ title: "Vidplay", streamUrl: vidwish.streamUrl, headers: vidwish.headers });
        if (!subtitles && vidwish.subtitles) { subtitles = vidwish.subtitles; subtitlesHeaders = vidwish.subtitlesHeaders; }
        allSubtitles.push(...vidwish.allSubtitles);
    }

    if (streams.length === 0) {
        console.log("[Direct] data-id found but getSources returned nothing usable");
        return null;
    }

    console.log("[Direct] Resolved " + streams.length + " stream(s) via direct Megaplay/MAL lookup");
    return { streams, subtitles, subtitlesHeaders, allSubtitles };
}

async function fetchMegaplaySources(fileId) {
    const url = `${MEGAPLAY}/stream/getSources?id=${fileId}&id=${fileId}`;
    const resp = await soraFetch(url, { headers: { "Referer": MEGAPLAY + "/", "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
    if (!resp || resp.status !== 200 || typeof resp.json !== "function") return null;
    let data;
    try { data = await resp.json(); } catch (e) { return null; }
    if (!data?.sources?.file) return null;
    console.log("[Direct] Megaplay tracks field: " + JSON.stringify(data.tracks ?? "MISSING") + " | full response keys: " + JSON.stringify(Object.keys(data)));
    return buildStreamResult(data, MEGAPLAY + "/");
}

async function fetchVidwishSources(realId, audio) {
    const embedUrl = `${VIDWISH}/stream/s-2/${realId}/${audio}`;
    const embedResp = await soraFetch(embedUrl, { headers: { "Referer": VIDWISH + "/", "User-Agent": UA } });
    if (!embedResp || embedResp.status !== 200) return null;
    const embedHtml = await embedResp.text();
    const fileId = embedHtml.match(/data-id="([^"]*)"/)?.[1];
    if (!fileId) return null;

    const url = `${VIDWISH}/stream/getSources?id=${fileId}&id=${fileId}`;
    const resp = await soraFetch(url, { headers: { "Referer": VIDWISH + "/", "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
    if (!resp || resp.status !== 200 || typeof resp.json !== "function") return null;
    let data;
    try { data = await resp.json(); } catch (e) { return null; }
    if (!data?.sources?.file) return null;
    return buildStreamResult(data, VIDWISH + "/");
}

// Shared subtitle/stream shaping — same contract used across both paths.
function buildStreamResult(data, referer) {
    const tracks = data.tracks || [];
    let englishSub = "";
    const engTrack = tracks.find(t => t.kind === "captions" && t.label && t.label.toLowerCase().includes("english"));
    if (engTrack?.file) englishSub = engTrack.file;
    else {
        const firstCaption = tracks.find(t => t.kind === "captions" && t.file);
        if (firstCaption) englishSub = firstCaption.file;
    }
    const allSubtitles = tracks.filter(t => t.file).map(t => ({
        url: t.file, label: t.label || t.kind, kind: t.kind, headers: { Referer: referer }
    }));
    return {
        streamUrl: data.sources.file,
        subtitles: englishSub,
        subtitlesHeaders: { Referer: referer },
        allSubtitles,
        headers: { Referer: referer }
    };
}

// ══════════════════════════════════════════════════════════════════
// Fallback path — full Anikoto site scrape. Only used when the direct
// Megaplay/MAL lookup finds nothing, or when AniList doesn't know the
// episode count yet.
// ══════════════════════════════════════════════════════════════════
class AnikotoFallback {
    // Confirmed live: real results live in #list-items. The page also
    // carries a "Top rated anime" sidebar using the identical
    // <a class="item" href=".../watch/..."> pattern — unscoped matching
    // grabbed an entry from that sidebar instead of an actual search
    // result. Also: "take the first match" is wrong even within real
    // results, since a title search can return multiple same-franchise
    // entries (specials, movies, spinoff arcs) — real title matching is
    // needed. Each result item also carries its numeric show ID directly
    // via data-tip, so this returns it without a separate watch-page fetch.
    static async findShow(title) {
        const url = ANIKOTO_BASE + "/filter?keyword=" + encodeURIComponent(title);
        console.log("[Fallback] Searching Anikoto: " + url);

        const resp = await soraFetch(url, { headers: { "User-Agent": UA, "Referer": ANIKOTO_BASE + "/" } });
        if (!resp || resp.status !== 200) {
            console.error("[Fallback] Search fetch failed, status: " + (resp ? resp.status : "null"));
            return null;
        }
        const html = await resp.text();

        const gridStart = html.indexOf('id="list-items"');
        if (gridStart === -1) {
            console.warn("[Fallback] No results grid found for: " + title);
            return null;
        }
        const gridEndMarker = html.indexOf("pre-pagination", gridStart);
        const gridHtml = gridEndMarker === -1 ? html.slice(gridStart) : html.slice(gridStart, gridEndMarker);

        const blocks = gridHtml.split('<div class="item ">').slice(1);
        if (blocks.length === 0) {
            console.warn("[Fallback] No search results found for: " + title);
            return null;
        }

        const candidates = [];
        for (const block of blocks) {
            const slugMatch = block.match(/href="https:\/\/anikototv\.to\/watch\/([^"\/]+)\/ep-\d+"/);
            const tipMatch = block.match(/data-tip="(\d+)"/);
            const titleMatch = block.match(/data-jp="([^"]*)"/);
            if (!slugMatch || !tipMatch) continue;
            candidates.push({
                slug: slugMatch[1],
                showId: tipMatch[1],
                title: titleMatch ? titleMatch[1] : ""
            });
        }
        if (candidates.length === 0) {
            console.warn("[Fallback] Could not parse any results for: " + title);
            return null;
        }

        const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const wantedNorm = normalize(title);
        const exact = candidates.find(c => normalize(c.title) === wantedNorm);
        const chosen = exact || candidates[0];

        console.log("[Fallback] Matched: \"" + chosen.title + "\" (slug: " + chosen.slug + ", showId: " + chosen.showId + ") for search: " + title
            + (exact ? "" : " [no exact title match among " + candidates.length + " results — using first]"));

        return chosen; // { slug, showId, title }
    }

    static async getEpisodes(showId, expectedMalId) {
        const url = ANIKOTO_BASE + "/ajax/episode/list/" + showId;
        const resp = await soraFetch(url, {
            headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": ANIKOTO_BASE + "/" }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") {
            console.warn("[Fallback] Episode list fetch failed for showId " + showId + ", status: " + (resp ? resp.status : "null"));
            return [];
        }
        let json;
        try { json = await resp.json(); } catch (e) {
            console.warn("[Fallback] Episode list JSON parse failed for showId " + showId);
            return [];
        }
        const html = json?.result || "";
        if (!html) {
            console.warn("[Fallback] Episode list result HTML was empty for showId " + showId);
        }

        const episodes = [];
        const re = /<a\s[^>]*data-id="[^"]*"[^>]*>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const tag = m[0];
            const g = (attr) => tag.match(new RegExp("data-" + attr + '="([^"]*)"'))?.[1] || "";
            const num = g("num"), ids = g("ids");
            if (!num || !ids) continue;
            episodes.push({ num: parseInt(num, 10), hasDub: g("dub") === "1", ids, mal: g("mal") });
        }

        // Cross-check: every episode carries its own data-mal attribute. If it
        // doesn't match what AniList told us to look for, findShow() matched
        // the wrong anime — bail rather than silently serving the wrong show.
        if (expectedMalId && episodes.length > 0) {
            const actualMal = episodes.find(e => e.mal)?.mal;
            if (actualMal && String(actualMal) !== String(expectedMalId)) {
                console.warn("[Fallback] Show mismatch — expected MAL id " + expectedMalId + " but episode list belongs to MAL id " + actualMal + ". findShow() likely matched the wrong anime.");
                return [];
            }
        }

        console.log("[Fallback] Parsed " + episodes.length + " episodes for showId " + showId + ", dub count: " + episodes.filter(e => e.hasDub).length);
        return episodes;
    }

    static async getServerList(idsToken, audio) {
        const url = ANIKOTO_BASE + "/ajax/server/list?servers=" + encodeURIComponent(idsToken);
        const resp = await soraFetch(url, {
            headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": ANIKOTO_BASE + "/" }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") return [];
        let json;
        try { json = await resp.json(); } catch (e) { return []; }
        const html = json?.result || "";

        const items = [];
        const typeRe = /<div class="type" data-type="(sub|dub)">([\s\S]*?)<\/ul>\s*<\/div>/g;
        let typeM;
        while ((typeM = typeRe.exec(html)) !== null) {
            if (typeM[1] !== audio) continue;
            for (const li of typeM[2].matchAll(/<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g)) {
                const linkId = li[1].match(/data-link-id="([^"]+)"/)?.[1];
                const name = li[2].replace(/<[^>]+>/g, "").trim();
                if (linkId) items.push({ linkId, name });
            }
        }
        return items;
    }

    static async resolveServer(linkId) {
        const url = ANIKOTO_BASE + "/ajax/server?get=" + encodeURIComponent(linkId);
        const resp = await soraFetch(url, {
            headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": ANIKOTO_BASE + "/" }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") return null;
        let json;
        try { json = await resp.json(); } catch (e) { return null; }
        return json?.result?.url || null;
    }

    // megaplay.buzz and vidwish.live share the same embed template
    // (data-id attribute + /stream/getSources?id= endpoint) — confirmed
    // live. vidtube.site's embed page looked like the same template by
    // title/warning text, but its real API differs: the endpoint is
    // /stream/getSourcesNew (not getSources) and requires an explicit
    // type=dub param — confirmed live. Response shape (sources.file,
    // tracks[]) is identical across all three, so buildStreamResult()
    // is unchanged; only the request URL branches per host.
    static async extractFromEmbed(embedUrl) {
        const host = [MEGAPLAY, VIDWISH, VIDTUBE].find(h => embedUrl.includes(h.replace("https://", "")));
        if (!host) {
            console.warn("[Fallback] Unrecognized dub server host — no extractor for: " + embedUrl);
            return null;
        }
        const fileId = await extractFileId(embedUrl, host + "/");
        if (!fileId) return null;

        const sourcesUrl = host === VIDTUBE
            ? `${host}/stream/getSourcesNew?id=${fileId}&type=dub&id=${fileId}&type=dub`
            : `${host}/stream/getSources?id=${fileId}&id=${fileId}`;

        const resp = await soraFetch(sourcesUrl, {
            headers: { "Referer": host + "/", "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") return null;
        let data; try { data = await resp.json(); } catch (e) { return null; }
        if (!data?.sources?.file) return null;
        return buildStreamResult(data, host + "/");
    }

    // Resolves via the full chain: search -> showId -> episode list -> per-episode
    // ids token -> dub server list -> resolve each token -> extract.
    static async resolve(title, epNum, expectedMalId) {
        const show = await AnikotoFallback.findShow(title);
        if (!show) return null;
        const episodes = await AnikotoFallback.getEpisodes(show.showId, expectedMalId);
        const ep = episodes.find(e => e.num === epNum);
        if (!ep || !ep.hasDub) {
            console.warn("[Fallback] Anikoto has no dub for episode " + epNum + " either");
            return null;
        }

        const dubServers = await AnikotoFallback.getServerList(ep.ids, "dub");
        if (dubServers.length === 0) return null;

        const results = await Promise.allSettled(dubServers.map(async (server) => {
            const embedUrl = await AnikotoFallback.resolveServer(server.linkId);
            if (!embedUrl) return null;
            const streamData = await AnikotoFallback.extractFromEmbed(embedUrl);
            if (!streamData) return null;
            return { title: server.name, ...streamData };
        }));

        const streams = [];
        let subtitles = "", subtitlesHeaders = {}, allSubtitles = [];
        for (const r of results) {
            if (r.status !== "fulfilled" || !r.value) continue;
            const s = r.value;
            streams.push({ title: s.title, streamUrl: s.streamUrl, headers: s.headers });
            if (!subtitles && s.subtitles) { subtitles = s.subtitles; subtitlesHeaders = s.subtitlesHeaders; }
            if (s.allSubtitles?.length) allSubtitles.push(...s.allSubtitles);
        }
        if (streams.length === 0) return null;

        console.log("[Fallback] Resolved " + streams.length + " stream(s) via full Anikoto scrape chain");
        return { streams, subtitles, subtitlesHeaders, allSubtitles };
    }

    // Only used when AniList doesn't know the episode count.
    static async getEpisodeCount(title, expectedMalId) {
        const show = await AnikotoFallback.findShow(title);
        if (!show) return null;
        const episodes = await AnikotoFallback.getEpisodes(show.showId, expectedMalId);
        const dubEpisodes = episodes.filter(e => e.hasDub).map(e => e.num);
        return dubEpisodes.length ? Math.max(...dubEpisodes) : null;
    }
}

async function extractFileId(embedUrl, referer) {
    const resp = await soraFetch(embedUrl, { headers: { "Referer": referer, "User-Agent": UA } });
    if (!resp || resp.status !== 200) return null;
    const html = await resp.text();
    return html.match(/data-id="([^"]*)"/)?.[1] || null;
}

// ══════════════════════════════════════════════════════════════════
// Shirox entry points
// ══════════════════════════════════════════════════════════════════
async function searchResults(keyword) {
    try {
        console.log("[searchResults] Keyword: " + keyword);
        const items = await AniList.search(keyword);
        if (!items) return JSON.stringify([{ title: "Error", image: "", href: "" }]);

        const transformed = items.map(item => ({
            title: item.title,
            image: item.poster,
            href: "anime/" + item.malId + "?title=" + encodeURIComponent(item.title) + "&eps=" + (item.episodes ?? "") + "&al=" + (item.anilistId ?? "")
        }));

        return JSON.stringify(transformed);
    } catch (error) {
        console.log("[searchResults] Fetch error: " + error);
        return JSON.stringify([{ title: "Error", image: "", href: "" }]);
    }
}

async function extractDetails(url) {
    try {
        const match = url.match(/anime\/(\d+)\?title=([^&]+)&eps=(\d*)&al=(\d*)/);
        if (!match) throw new Error("Invalid URL format");
        const [, , titleEncoded, eps, anilistId] = match;
        const title = decodeURIComponent(titleEncoded);

        const details = anilistId ? await AniList.getDetails(anilistId) : null;
        if (details) {
            return JSON.stringify([{
                description: details.synopsis || "No description available",
                aliases: [details.genres, details.season].filter(Boolean).join(" • ") || ("Episodes: " + (eps || "Unknown")),
                airdate: details.status ? "Status: " + details.status : "Aired: Unknown"
            }]);
        }

        // Fallback if the detail lookup fails or no AniList id was carried
        console.warn("[extractDetails] AniList detail lookup unavailable, using minimal fallback");
        return JSON.stringify([{
            description: title,
            aliases: eps ? "Episodes: " + eps : "Episodes: Unknown",
            airdate: "Aired: Unknown"
        }]);
    } catch (error) {
        console.log("Details error: " + error);
        return JSON.stringify([{ description: "Error loading description", aliases: "", airdate: "" }]);
    }
}

async function extractEpisodes(url) {
    try {
        const match = url.match(/anime\/(\d+)\?title=([^&]+)&eps=(\d*)/);
        if (!match) throw new Error("Invalid URL format");
        const [, malId, titleEncoded, epsStr] = match;
        const title = decodeURIComponent(titleEncoded);

        let epCount = epsStr ? parseInt(epsStr, 10) : null;
        if (!epCount) {
            console.log("[extractEpisodes] AniList episode count unknown — checking Anikoto");
            epCount = await AnikotoFallback.getEpisodeCount(title, malId);
        }
        if (!epCount) {
            console.warn("[extractEpisodes] Could not determine episode count for: " + title);
            return JSON.stringify([]);
        }

        const episodesArray = [];
        for (let n = 1; n <= epCount; n++) {
            episodesArray.push({
                href: "anime/" + malId + "/" + n + "?title=" + encodeURIComponent(title),
                number: n,
                title: "Episode " + n
            });
        }
        return JSON.stringify(episodesArray);
    } catch (error) {
        console.log("Fetch error in extractEpisodes: " + error);
        return JSON.stringify([]);
    }
}

async function extractStreamUrl(url) {
    try {
        const match = url.match(/anime\/(\d+)\/(\d+)\?title=([^&]+)/);
        if (!match) throw new Error("Invalid URL format");
        const [, malId, epNumStr, titleEncoded] = match;
        const epNum = parseInt(epNumStr, 10);
        const title = decodeURIComponent(titleEncoded);

        console.log("[extractStreamUrl] MAL: " + malId + ", Episode: " + epNum + ", Title: " + title);

        // Primary: scrape Anikoto's own site for this exact episode, same
        // as every other module — real servers currently on the page
        // (Megaplay, Vidplay, VidTube, whatever's live), not a guess.
        let result = await AnikotoFallback.resolve(title, epNum, malId);

        // Fallback: only if Anikoto genuinely has nothing for this episode
        // (title didn't match cleanly, or the show truly has no dub there
        // yet) — try the direct Megaplay/MAL shortcut as a last resort.
        if (!result) {
            console.log("[extractStreamUrl] Anikoto scrape found nothing — trying direct Megaplay/MAL as fallback");
            result = await tryMegaplayDirect(malId, epNum, "dub");
        }

        if (!result) {
            console.warn("[extractStreamUrl] No dub found via either path");
            return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
        }

        // De-duplicate subtitle tracks across providers
        const seenSub = {};
        result.allSubtitles = result.allSubtitles.filter(t => {
            if (!t.url || seenSub[t.url]) return false;
            seenSub[t.url] = true;
            return true;
        });

        const out = JSON.stringify(result);
        console.log("[extractStreamUrl] Result: " + out.substring(0, 300));
        return out;
    } catch (error) {
        console.log("[extractStreamUrl] Fetch error: " + error);
        return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
    }
}

// ─── soraFetch (existing wrapper) ───
async function soraFetch(url, options = { headers: {}, method: "GET", body: null, encoding: "utf-8" }) {
    try {
        return await fetchv2(
            url,
            options.headers ?? {},
            options.method ?? "GET",
            options.body ?? null,
            true,
            options.encoding ?? "utf-8"
        );
    } catch (e) {
        try {
            return await fetch(url, options);
        } catch (error) {
            return null;
        }
    }
}
