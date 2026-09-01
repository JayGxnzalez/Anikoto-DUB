const ANIKOTO_BASE = "https://anikototv.to";
const MEGAPLAY = "https://megaplay.buzz";
const VIDWISH = "https://vidwish.live";
const VIDTUBE = "https://vidtube.site";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Shared subtitle/stream shaping — used by the embed extractor.
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
// Anikoto site scrape — search, details, episode list, server list.
// Everything comes directly from anikototv.to, same pattern as every
// other module: search the real site, use whatever's actually there.
// No external ID service (AniList/MAL) involved anywhere in this file.
// ══════════════════════════════════════════════════════════════════
class Anikoto {
    // Confirmed live: real results live in #list-items. The page also
    // carries a "Top rated anime" sidebar using the identical
    // <a class="item" href=".../watch/..."> pattern, so this scopes
    // strictly to the results grid rather than matching anywhere on
    // the page. Each item card carries its numeric show ID directly
    // via data-tip, so no separate watch-page fetch is needed to get it.
    static async search(keyword) {
        const url = ANIKOTO_BASE + "/filter?keyword=" + encodeURIComponent(keyword);
        console.log("[Anikoto] Searching: " + url);

        const resp = await soraFetch(url, { headers: { "User-Agent": UA, "Referer": ANIKOTO_BASE + "/" } });
        if (!resp || resp.status !== 200) {
            console.error("[Anikoto] Search fetch failed, status: " + (resp ? resp.status : "null"));
            return [];
        }
        const html = await resp.text();

        const gridStart = html.indexOf('id="list-items"');
        if (gridStart === -1) {
            console.warn("[Anikoto] No results grid found for: " + keyword);
            return [];
        }
        const gridEndMarker = html.indexOf("pre-pagination", gridStart);
        const gridHtml = gridEndMarker === -1 ? html.slice(gridStart) : html.slice(gridStart, gridEndMarker);

        const blocks = gridHtml.split('<div class="item ">').slice(1);
        const results = [];
        for (const block of blocks) {
            const slugMatch = block.match(/href="https:\/\/anikototv\.to\/watch\/([^"\/]+)\/ep-\d+"/);
            const tipMatch = block.match(/data-tip="(\d+)"/);
            // Visible anchor text (English title), not data-jp — that
            // attribute holds the Japanese/romaji title.
            const titleMatch = block.match(/<a class="name d-title"[^>]*>([^<]*)<\/a>/);
            const posterMatch = block.match(/<img\s+src="([^"]+)"/);
            if (!slugMatch || !tipMatch) continue;
            results.push({
                slug: slugMatch[1],
                showId: tipMatch[1],
                title: titleMatch ? titleMatch[1].trim() : "Untitled",
                poster: posterMatch ? posterMatch[1] : ""
            });
        }

        console.log("[Anikoto] Search returned " + results.length + " item(s)");
        return results;
    }

    // Best-effort scrape of the watch page's info block. Built from
    // confirmed real markup (Bleach watch page capture), but watch pages
    // may vary slightly by content type (movie/special vs TV) — treat
    // any single field coming back empty as expected, not a bug.
    static async getDetails(slug) {
        const url = ANIKOTO_BASE + "/watch/" + slug;
        const resp = await soraFetch(url, { headers: { "User-Agent": UA, "Referer": ANIKOTO_BASE + "/" } });
        if (!resp || resp.status !== 200) return null;
        const html = await resp.text();

        const synMatch = html.match(/<div class="synopsis[^"]*">[\s\S]*?<div class="content">([\s\S]*?)<\/div>/);
        const synopsis = synMatch
            ? synMatch[1].replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+(>|$)/g, "").trim()
            : "";

        const getField = (label) => {
            const re = new RegExp(label + ":\\s*<span>\\s*(?:<a[^>]*>)?\\s*([^<]*?)\\s*(?:<\\/a>)?\\s*<\\/span>", "i");
            const m = html.match(re);
            return m ? m[1].trim() : "";
        };

        const genres = [...html.matchAll(/<a href="https:\/\/anikototv\.to\/genre\/[^"]*">\s*([^<]+?)\s*<\/a>/g)]
            .slice(0, 6)
            .map(m => m[1].trim())
            .join(", ");

        return {
            synopsis,
            aired: getField("Aired"),
            status: getField("Status"),
            duration: getField("Duration"),
            genres
        };
    }

    // Confirmed live, byte-perfect: data-id/num/slug/sub/dub/ids on each
    // episode anchor.
    static async getEpisodes(showId) {
        const url = ANIKOTO_BASE + "/ajax/episode/list/" + showId;
        const resp = await soraFetch(url, {
            headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": ANIKOTO_BASE + "/" }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") {
            console.warn("[Anikoto] Episode list fetch failed for showId " + showId + ", status: " + (resp ? resp.status : "null"));
            return [];
        }
        let json;
        try { json = await resp.json(); } catch (e) {
            console.warn("[Anikoto] Episode list JSON parse failed for showId " + showId);
            return [];
        }
        const html = json?.result || "";
        if (!html) {
            console.warn("[Anikoto] Episode list result HTML was empty for showId " + showId);
        }

        const episodes = [];
        const re = /<a\s[^>]*data-id="[^"]*"[^>]*>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const tag = m[0];
            const g = (attr) => tag.match(new RegExp("data-" + attr + '="([^"]*)"'))?.[1] || "";
            const num = g("num"), ids = g("ids");
            if (!num || !ids) continue;
            episodes.push({ num: parseInt(num, 10), hasDub: g("dub") === "1", ids });
        }

        console.log("[Anikoto] Parsed " + episodes.length + " episodes for showId " + showId + ", dub count: " + episodes.filter(e => e.hasDub).length);
        return episodes;
    }

    // Confirmed live: HTML with sub/dub <div class="type"> blocks, each
    // server <li> carrying a data-link-id token.
    static async getServerList(idsToken, audio) {
        const url = ANIKOTO_BASE + "/ajax/server/list?servers=" + encodeURIComponent(idsToken);
        const resp = await soraFetch(url, {
            headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": ANIKOTO_BASE + "/" }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") {
            console.warn("[Anikoto] Server list fetch failed, status: " + (resp ? resp.status : "null"));
            return [];
        }
        let json;
        try { json = await resp.json(); } catch (e) {
            console.warn("[Anikoto] Server list JSON parse failed");
            return [];
        }
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
        console.log("[Anikoto] Found " + items.length + " " + audio + " server(s)");
        return items;
    }

    // Confirmed live, many times.
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
    // live. vidtube.site's embed page looks like the same template by
    // title/warning text, but its real API differs: the endpoint is
    // /stream/getSourcesNew (not getSources) and requires an explicit
    // type=dub param — confirmed live. Response shape (sources.file,
    // tracks[]) is identical across all three, so buildStreamResult()
    // is unchanged; only the request URL branches per host.
    static async extractFromEmbed(embedUrl) {
        const host = [MEGAPLAY, VIDWISH, VIDTUBE].find(h => embedUrl.includes(h.replace("https://", "")));
        if (!host) {
            console.warn("[Anikoto] Unrecognized dub server host — no extractor for: " + embedUrl);
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
        const items = await Anikoto.search(keyword);
        if (!items) return JSON.stringify([{ title: "Error", image: "", href: "" }]);

        const transformed = items.map(item => ({
            title: item.title,
            image: item.poster,
            href: "anime/" + item.slug + "?showId=" + item.showId
        }));

        return JSON.stringify(transformed);
    } catch (error) {
        console.log("[searchResults] Fetch error: " + error);
        return JSON.stringify([{ title: "Error", image: "", href: "" }]);
    }
}

async function extractDetails(url) {
    try {
        const match = url.match(/anime\/([^\/\?]+)/);
        if (!match) throw new Error("Invalid URL format");
        const slug = match[1];

        const details = await Anikoto.getDetails(slug);
        if (!details) throw new Error("Could not fetch details");

        return JSON.stringify([{
            description: details.synopsis || "No description available",
            aliases: details.genres || ("Duration: " + (details.duration || "Unknown")),
            airdate: details.aired ? "Aired: " + details.aired : (details.status ? "Status: " + details.status : "Aired: Unknown")
        }]);
    } catch (error) {
        console.log("Details error: " + error);
        return JSON.stringify([{
            description: "Error loading description",
            aliases: "",
            airdate: "Aired: Unknown"
        }]);
    }
}

// Only dub-available episodes are listed (data-dub="1" on Anikoto's own
// episode list) — no dead entries that fail at play time.
async function extractEpisodes(url) {
    try {
        const match = url.match(/anime\/([^\/\?]+)\?showId=(\d+)/);
        if (!match) throw new Error("Invalid URL format");
        const [, slug, showId] = match;

        const episodesData = await Anikoto.getEpisodes(showId);
        if (!episodesData) return JSON.stringify([]);

        const dubOnly = episodesData.filter(ep => ep.hasDub);
        console.log("[extractEpisodes] " + dubOnly.length + " of " + episodesData.length + " episodes have a dub");

        const sorted = dubOnly.sort((a, b) => a.num - b.num);
        const episodesArray = sorted.map(ep => ({
            href: "anime/" + slug + "/" + ep.num + "?ids=" + encodeURIComponent(ep.ids),
            number: ep.num,
            title: "Episode " + ep.num
        }));

        return JSON.stringify(episodesArray);
    } catch (error) {
        console.log("Fetch error in extractEpisodes: " + error);
        return JSON.stringify([]);
    }
}

async function extractStreamUrl(url) {
    try {
        const match = url.match(/anime\/([^\/]+)\/(\d+)\?ids=(.+)/);
        if (!match) throw new Error("Invalid URL format");
        const [, slug, epNumStr, idsEncoded] = match;
        const epNum = parseInt(epNumStr, 10);
        const idsToken = decodeURIComponent(idsEncoded);

        console.log("[extractStreamUrl] Slug: " + slug + ", Episode: " + epNum);

        const dubServers = await Anikoto.getServerList(idsToken, "dub");
        if (dubServers.length === 0) {
            console.warn("[extractStreamUrl] No dub servers available for this episode");
            return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
        }

        // Anikoto's own server labels carry a trailing "-N" on Vidstream/
        // Vidplay entries (e.g. "Vidstream-2") that's just noise here —
        // strip it. HD-1/HD-2 are left untouched since the number there
        // is meaningful (distinguishes two real, different servers).
        const cleanLabel = (name) => name.replace(/^(Vidstream|Vidplay)-\d+$/, "$1");

        const results = await Promise.allSettled(dubServers.map(async (server) => {
            const embedUrl = await Anikoto.resolveServer(server.linkId);
            if (!embedUrl) return null;
            const streamData = await Anikoto.extractFromEmbed(embedUrl);
            if (!streamData) return null;
            return { title: cleanLabel(server.name), ...streamData };
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

        if (streams.length === 0) {
            console.warn("[extractStreamUrl] Dub servers found but none resolved to a working stream");
            return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
        }

        // De-duplicate subtitle tracks across providers
        const seenSub = {};
        allSubtitles = allSubtitles.filter(t => {
            if (!t.url || seenSub[t.url]) return false;
            seenSub[t.url] = true;
            return true;
        });

        const out = JSON.stringify({ streams, subtitles, subtitlesHeaders, allSubtitles });
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
