class Anikoto {
    // ---------- Search ----------
    static async search(keyword) {
        const base = "https://animepahetv.to/search?q=" + encodeURIComponent(keyword).replace(/%20/g, "+");
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Referer": "https://animepahetv.to/"
        };

        console.log("[Anikoto] Searching HTML pages, page 1: " + base);

        const resp1 = await soraFetch(base, { headers });
        if (!resp1 || resp1.status !== 200) {
            console.error("[Anikoto] Failed to fetch page 1");
            return [];
        }
        const html1 = await resp1.text();

        let totalPages = 1;
        const lastLinkMatch = html1.match(/<a\s+title="Last"\s+class="page-link"\s+href="[^"]*&?page=(\d+)"/i);
        if (lastLinkMatch) {
            totalPages = parseInt(lastLinkMatch[1], 10);
            console.log("[Anikoto] Total pages: " + totalPages);
        } else {
            const pageMatches = [...html1.matchAll(/<a[^>]*href="[^"]*&?page=(\d+)"[^>]*>/ig)];
            if (pageMatches.length > 0) {
                const nums = pageMatches.map(m => parseInt(m[1], 10)).filter(n => !isNaN(n));
                if (nums.length > 0) totalPages = Math.max(...nums);
                console.log("[Anikoto] Detected total pages: " + totalPages);
            }
        }

        const parsePage = (html) => {
            const items = [];
            const blocks = html.split('<div class="anime-item">');
            for (let i = 1; i < blocks.length; i++) {
                const block = blocks[i];
                const posterLinkMatch = block.match(/<a\s+[^>]*href="https:\/\/animepahetv\.to\/anime\/([^"]+)"[^>]*class="anime-poster"/);
                if (!posterLinkMatch) continue;
                const session = posterLinkMatch[1];
                const titleMatch = block.match(/<div\s+class="anime-name">\s*<a[^>]*>([^<]+)<\/a>/);
                const title = titleMatch ? titleMatch[1].trim() : "Untitled";
                const imgMatch = block.match(/<img\s+[^>]*src="([^"]+)"[^>]*class="lazyload"/);
                const poster = imgMatch ? imgMatch[1] : "";
                items.push({ title, poster, session });
            }
            return items;
        };

        let allItems = parsePage(html1);

        if (totalPages > 1) {
            const pagePromises = [];
            for (let p = 2; p <= totalPages; p++) {
                const url = base + "&page=" + p;
                console.log("[Anikoto] Fetching page " + p + ": " + url);
                pagePromises.push(soraFetch(url, { headers }).then(resp => {
                    if (!resp || resp.status !== 200) return "";
                    return resp.text();
                }));
            }
            const pageHTMLs = await Promise.allSettled(pagePromises);
            for (const result of pageHTMLs) {
                if (result.status === "fulfilled" && result.value) {
                    const items = parsePage(result.value);
                    allItems = allItems.concat(items);
                }
            }
        }

        console.log("[Anikoto] Search returned " + allItems.length + " items total");
        return allItems;
    }

    // ---------- Get episode list ----------
    static async getEpisodes(session) {
        const baseUrl = "https://animepahetv.to/viewApi?m=release&id=" + session + "&sort=episode_desc";
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01"
        };

        // Helper: fetch a page and return parsed JSON object
        const fetchPage = async (url) => {
            const resp = await soraFetch(url, { headers });
            if (!resp || resp.status !== 200) {
                console.error("[Anikoto] Page fetch failed, status: " + (resp ? resp.status : "null"));
                return null;
            }
            // Try standard .json() first, then fallback to text + JSON.parse
            if (typeof resp.json === "function") {
                try {
                    return await resp.json();
                } catch (e) {
                    console.error("[Anikoto] .json() failed:", e);
                }
            }
            // Fallback: parse JSON from text
            try {
                const text = await resp.text();
                return JSON.parse(text);
            } catch (e) {
                console.error("[Anikoto] JSON parse from text failed:", e);
                return null;
            }
        };

        // Fetch page 1
        const url1 = baseUrl + "&page=1";
        console.log("[Anikoto] Fetching episodes page 1: " + url1);
        const json1 = await fetchPage(url1);
        if (!json1 || !json1.data) {
            console.error("[Anikoto] Failed to get page 1 data");
            return [];
        }

        const allEpisodes = json1.data || [];
        const totalPages = json1.last_page || 1;
        console.log("[Anikoto] Episodes total pages: " + totalPages + " | first batch: " + allEpisodes.length);

        // Fetch remaining pages in parallel
        if (totalPages > 1) {
            const pagePromises = [];
            for (let p = 2; p <= totalPages; p++) {
                const url = baseUrl + "&page=" + p;
                console.log("[Anikoto] Scheduling fetch for page " + p + ": " + url);
                pagePromises.push(
                    fetchPage(url).then(json => {
                        if (json && json.data) {
                            console.log("[Anikoto] Page " + p + " data count: " + json.data.length);
                            allEpisodes.push(...json.data);
                        } else {
                            console.warn("[Anikoto] Page " + p + " returned no data");
                        }
                    }).catch(e => {
                        console.error("[Anikoto] Error fetching page " + p + ":", e);
                    })
                );
            }
            // Wait for all secondary pages to finish
            await Promise.allSettled(pagePromises);
        }

        // Sort ascending by episode number
        allEpisodes.sort((a, b) => a.episode - b.episode);
        console.log("[Anikoto] Total episodes fetched: " + allEpisodes.length);
        return allEpisodes;
    }

    // ---------- Get anime details (scrape HTML) ----------
    static async getDetails(session) {
        const url = "https://animepahetv.to/anime/" + session;
        console.log("[Anikoto] Fetching details: " + url);

        const resp = await soraFetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!resp || resp.status !== 200) return null;
        const html = await resp.text();

        const between = (str, a, b) => {
            const p = str.indexOf(a);
            if (p === -1) return "";
            const start = p + a.length;
            const end = str.indexOf(b, start);
            return end === -1 ? str.slice(start) : str.slice(start, end);
        };

        const title = between(html, '<h1 class="user-select-none"><span style="user-select:text">', '</span>').trim();
        const japanese = between(html, '<h2 class="japanese" style="font-weight:600">', '</h2>').trim();
        const synopsis = between(html, '<div class="anime-synopsis">', '</div>')
            .replace(/<br\s*\/?>/g, '\n')
            .replace(/<\/?[^>]+(>|$)/g, '')
            .trim();

        const infoBlock = between(html, '<div class="col-sm-4 anime-info">', '</div>');
        const getInfo = (label) => {
            const regex = new RegExp("<strong>" + label + "[\\s\\S]*?<\\/p>", "i");
            const match = infoBlock.match(regex);
            if (!match) return "";
            return match[0].replace(/<[^>]+>/g, "").replace(label, "").trim();
        };

        const type = getInfo("Type:");
        const episodes = getInfo("Episode:");
        const status = getInfo("Status:");
        const duration = getInfo("Duration:");
        const aired = getInfo("Aired:");
        const season = getInfo("Season:");
        const studio = getInfo("Studio:");
        const genres = [...infoBlock.matchAll(/<a\s+href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)<\/a>/g)]
            .map(m => m[1].trim());

        const posterMatch = html.match(/<img\s+[^>]*data-src="([^"]+)"[^>]*class="lazyload"/);
        const poster = posterMatch ? posterMatch[1] : "";

        return { title, japanese, synopsis, type, episodes, status, duration, aired, season, studio, genres, poster };
    }

    // ---------- Get stream servers for an episode ----------
    static async getServers(episodeSession) {
        const url = "https://animepahetv.to/anime/get-servers/" + episodeSession;
        console.log("[Anikoto] Fetching servers: " + url);

        const resp = await soraFetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!resp || resp.status !== 200 || typeof resp.json !== "function") return null;
        let json;
        try { json = await resp.json(); } catch (e) { return null; }
        return json?.servers || [];
    }

    // ---------- Extract Megaplay stream from server URL ----------
    static async extractMegaplayStream(serverUrl) {
        console.log("[Anikoto] Fetching Megaplay embed: " + serverUrl);
        const resp = await soraFetch(serverUrl, {
            headers: {
                "Referer": "https://megaplay.buzz/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!resp || resp.status !== 200) return null;
        const html = await resp.text();

        const dataIdMatch = html.match(/data-id="(\d+)"/);
        if (!dataIdMatch) return null;
        const dataId = dataIdMatch[1];

        const sourcesUrl = "https://megaplay.buzz/stream/getSources?id=" + dataId + "&id=" + dataId;
        console.log("[Anikoto] Fetching sources: " + sourcesUrl);
        const srcResp = await soraFetch(sourcesUrl, {
            headers: {
                "Referer": "https://megaplay.buzz/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!srcResp || srcResp.status !== 200 || typeof srcResp.json !== "function") return null;
        let data;
        try { data = await srcResp.json(); } catch (e) { return null; }
        if (!data?.sources?.file) return null;

        // Subtitle extraction
        const tracks = data.tracks || [];
        console.log("[Anikoto] Source tracks: " + JSON.stringify(tracks));

        let englishSub = "";
        const engTrack = tracks.find(t =>
            t.kind === "captions" &&
            t.label &&
            t.label.toLowerCase().includes("english")
        );
        if (engTrack && engTrack.file) englishSub = engTrack.file;
        else {
            const firstCaption = tracks.find(t => t.kind === "captions" && t.file);
            if (firstCaption) englishSub = firstCaption.file;
        }

        // All subtitle tracks with required headers
        const allSubtitles = tracks
            .filter(t => t.file)
            .map(t => ({
                url: t.file,
                label: t.label || t.kind,
                kind: t.kind,
                headers: { Referer: "https://megaplay.buzz/" }
            }));

        return {
            streamUrl: data.sources.file,
            subtitles: englishSub,
            subtitlesHeaders: { Referer: "https://megaplay.buzz/" },
            allSubtitles: allSubtitles,
            headers: { Referer: "https://megaplay.buzz/" }
        };
    }

    static async extractVidplayStream(serverUrl) {
        console.log("[Anikoto] Fetching Vidplay embed: " + serverUrl);
        const resp = await soraFetch(serverUrl, {
            headers: {
                "Referer": "https://vidwish.live/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!resp || resp.status !== 200) return null;
        const html = await resp.text();

        const dataIdMatch = html.match(/data-id="(\d+)"/);
        if (!dataIdMatch) return null;
        const dataId = dataIdMatch[1];

        const sourcesUrl = "https://vidwish.live/stream/getSources?id=" + dataId + "&id=" + dataId;
        console.log("[Anikoto] Fetching Vidplay sources: " + sourcesUrl);
        const srcResp = await soraFetch(sourcesUrl, {
            headers: {
                "Referer": serverUrl,
                "X-Requested-With": "XMLHttpRequest",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!srcResp || srcResp.status !== 200 || typeof srcResp.json !== "function") {
            console.warn("[Anikoto] Vidplay getSources failed — status: " + (srcResp ? srcResp.status : "null"));
            return null;
        }
        let data;
        try { data = await srcResp.json(); } catch (e) {
            console.warn("[Anikoto] Vidplay getSources JSON parse failed: " + e);
            return null;
        }
        if (!data?.sources?.file) {
            console.warn("[Anikoto] Vidplay getSources returned no file — keys: " + JSON.stringify(Object.keys(data || {})) + ", sources: " + JSON.stringify(data?.sources));
            return null;
        }

        const tracks = data.tracks || [];
        console.log("[Anikoto] Vidplay tracks: " + JSON.stringify(tracks));

        let englishSub = "";
        const engTrack = tracks.find(t =>
            t.kind === "captions" &&
            t.label &&
            t.label.toLowerCase().includes("english")
        );
        if (engTrack && engTrack.file) englishSub = engTrack.file;
        else {
            const firstCaption = tracks.find(t => t.kind === "captions" && t.file);
            if (firstCaption) englishSub = firstCaption.file;
        }

        const allSubtitles = tracks
            .filter(t => t.file)
            .map(t => ({
                url: t.file,
                label: t.label || t.kind,
                kind: t.kind,
                headers: { Referer: "https://vidwish.live/" }
            }));

        return {
            streamUrl: data.sources.file,
            subtitles: englishSub,
            subtitlesHeaders: { Referer: "https://vidwish.live/" },
            allSubtitles: allSubtitles,
            headers: { Referer: "https://vidwish.live/" }
        };
    }
}

async function extractStreamUrl(url) {
    try {
        const match = url.match(/anime\/([^\/]+)\/([^?]+)\?num=(\d+)/);
        if (!match) throw new Error("Invalid URL format");
        const [, animeSession, episodeSession, epNum] = match;

        console.log("[Anikoto] Anime: " + animeSession + ", Episode: " + epNum + ", Session: " + episodeSession);

        const servers = await Anikoto.getServers(episodeSession);
        if (!servers || servers.length === 0) {
            console.warn("[extractStreamUrl] No servers found");
            return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
        }

        // DUB-only servers
        const megaDub = servers.find(s => s.name === "Dub-Megaplay");
        const vidplayDub = servers.find(s => s.name.includes("Vidplay") && s.name.includes("Dub"));

        if (!megaDub && !vidplayDub) {
            console.warn("[extractStreamUrl] No dub servers available for this episode");
            return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
        }

        // Helper functions (return allSubtitles too)
        async function fetchMegaplayStream(server) {
            if (!server) return null;
            const streamData = await Anikoto.extractMegaplayStream(server.url);
            if (!streamData) return null;
            return {
                title: server.name.replace("Dub-Megaplay", "Megaplay"),
                streamUrl: streamData.streamUrl,
                headers: streamData.headers,
                subtitles: streamData.subtitles,
                subtitlesHeaders: streamData.subtitlesHeaders,
                allSubtitles: streamData.allSubtitles
            };
        }

        async function fetchVidplayStream(server) {
            if (!server) return null;
            const streamData = await Anikoto.extractVidplayStream(server.url);
            if (!streamData) return null;
            return {
                title: server.name.replace("Dub-Vidplay", "Vidplay").replace("Vidplay-Dub", "Vidplay"),
                streamUrl: streamData.streamUrl,
                headers: streamData.headers,
                subtitles: streamData.subtitles,
                subtitlesHeaders: streamData.subtitlesHeaders,
                allSubtitles: streamData.allSubtitles
            };
        }

        // Fetch all DUB streams in parallel
        const [
            megaDubStream,
            vidDubStream
        ] = await Promise.allSettled([
            fetchMegaplayStream(megaDub),
            fetchVidplayStream(vidplayDub)
        ]);

        const streams = [];
        let subtitles = "";
        let subtitlesHeaders = {};
        let allSubtitles = [];

        // Process Megaplay DUB
        if (megaDubStream.status === "fulfilled" && megaDubStream.value) {
            const s = megaDubStream.value;
            streams.push({ title: s.title, streamUrl: s.streamUrl, headers: s.headers });
            if (!subtitles && s.subtitles) {
                subtitles = s.subtitles;
                subtitlesHeaders = s.subtitlesHeaders;
            }
            if (s.allSubtitles?.length) {
                allSubtitles.push(...s.allSubtitles);
            }
        }

        // Process Vidplay DUB
        if (vidDubStream.status === "fulfilled" && vidDubStream.value) {
            const s = vidDubStream.value;
            streams.push({ title: s.title, streamUrl: s.streamUrl, headers: s.headers });
            if (!subtitles && s.subtitles) {
                subtitles = s.subtitles;
                subtitlesHeaders = s.subtitlesHeaders;
            }
            if (s.allSubtitles?.length) {
                allSubtitles.push(...s.allSubtitles);
            }
        }

        // De-duplicate subtitle tracks (same url) across providers
        const seenSub = {};
        allSubtitles = allSubtitles.filter(t => {
            if (!t.url || seenSub[t.url]) return false;
            seenSub[t.url] = true;
            return true;
        });

        const result = JSON.stringify({ streams, subtitles, subtitlesHeaders, allSubtitles });
        console.log("[extractStreamUrl] Result: " + result.substring(0, 300));
        return result;

    } catch (error) {
        console.log("[extractStreamUrl] Fetch error: " + error);
        return JSON.stringify({ streams: [], subtitles: "", subtitlesHeaders: {}, allSubtitles: [] });
    }
}

// ─── Search Results ───
async function searchResults(keyword) {
    try {
        console.log("[searchResults] Keyword: " + keyword);
        const items = await Anikoto.search(keyword);
        if (!items) return JSON.stringify([{ title: "Error", image: "", href: "" }]);

        const transformed = items.map(item => ({
            title: item.title || "Untitled",
            image: item.poster || "",
            href: "anime/" + item.session
        }));

        console.log("Transformed Results: " + JSON.stringify(transformed));
        return JSON.stringify(transformed);
    } catch (error) {
        console.log("[searchResults] Fetch error: " + error);
        return JSON.stringify([{ title: "Error", image: "", href: "" }]);
    }
}

// ─── Extract Details ───
async function extractDetails(url) {
    try {
        const match = url.match(/anime\/([^\/]+)/);
        if (!match) throw new Error("Invalid URL format");
        const session = match[1];
        const details = await Anikoto.getDetails(session);
        if (!details) throw new Error("Could not fetch details");

        const transformed = [{
            description: details.synopsis || "No description available",
            aliases: "Duration: " + (details.duration || "Unknown"),
            airdate: "Aired: " + (details.aired || "Unknown")
        }];

        console.log(JSON.stringify(transformed));
        return JSON.stringify(transformed);
    } catch (error) {
        console.log("Details error: " + error);
        return JSON.stringify([{
            description: "Error loading description",
            aliases: "Duration: Unknown",
            airdate: "Aired/Released: Unknown"
        }]);
    }
}

// ─── Extract Episodes ───
async function extractEpisodes(url) {
    try {
        const match = url.match(/anime\/([^\/]+)/);
        if (!match) throw new Error("Invalid URL format");
        const session = match[1];
        const episodesData = await Anikoto.getEpisodes(session);
        if (!episodesData) return JSON.stringify([]);

        const sorted = episodesData.sort((a, b) => a.episode - b.episode);
        const episodesArray = sorted.map(ep => ({
            href: "anime/" + session + "/" + ep.session + "?num=" + ep.episode,
            number: ep.episode,
            title: ep.title || "Episode " + ep.episode
        }));

        return JSON.stringify(episodesArray);
    } catch (error) {
        console.log("Fetch error in extractEpisodes: " + error);
        return JSON.stringify([]);
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
