const { Telegraf, Markup } = require('telegraf');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "")
    .split(',')
    .map(id => id.trim())
    .filter(id => id);

// --- MEMORY STORAGE ---
global.batchStorage = global.batchStorage || {};
global.shortenerConfig = global.shortenerConfig || {
    domain: process.env.SHORTENER_DOMAIN || "",
    key: process.env.SHORTENER_KEY || ""
};
global.telegraphToken = global.telegraphToken || "";
global.awaitingShortenerConfig = global.awaitingShortenerConfig || {};

// --- ERROR HANDLING ---
bot.catch((err, ctx) => {
    console.error(`Bot Error:`, err);
    try {
        ctx.reply(`<b>Error: ${escapeHtml(err.message)}</b>`, { parse_mode: 'HTML' });
    } catch (e) {}
});

// --- HTML & STRING HELPERS ---
const escapeHtml = (str = "") => {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
};

const formatFileSize = (bytes = 0) => {
    if (!bytes || bytes <= 0) return "";
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
};

const getSizeTierLabel = (bytes = 0) => {
    if (!bytes || bytes <= 0) return "Pack";
    const mb = bytes / (1024 ** 2);
    if (mb < 500) return "~300MB";
    if (mb < 1150) return "~1GB";
    return "~1.4GB";
};

const extractResolutionTag = (text = "") => {
    const resMatch = String(text).match(/\b(2160p|4K|1440p|1080p|720p|480p|360p|240p)\b/i);
    if (!resMatch) return null;
    const val = resMatch[1].toUpperCase();
    return val === '4K' ? '4K' : val.toLowerCase();
};

const stripChannelNoise = (text = "") => {
    return String(text)
        .replace(/⭕️\s*Main Channel\s*:\s*@StarFlixTamil\s*⭕️/gi, "")
        .replace(/(Main Channel|Join Channel).*/gi, "")
        .replace(/@[\w_]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

const cleanCaption = (text, fileSize = 0) => {
    if (!text) return "Untitled File";
    let clean = stripChannelNoise(text)
        .replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|zip|rar|7z|part\d+)$/i, "")
        .trim();

    // Format "S01E03 Title" -> "S01E03 - Title" when no dash is present
    clean = clean.replace(/\b(S\d+E\d+)\s+(?!-\s*)/i, "$1 - ");

    const hasRes = extractResolutionTag(clean);
    const sizeStr = formatFileSize(fileSize);

    if (!hasRes && sizeStr && !/\[[^\]]+\]$/.test(clean)) {
        return `${clean} [${sizeStr}]`;
    }
    return clean;
};

const extractEpisodeNumber = (text = "") => {
    const match =
        String(text).match(/\bS\d+E(\d+)\b/i) ||
        String(text).match(/\bEP(?:ISODE)?\s*\(?(\d+)\)?\b/i);
    return match ? parseInt(match[1], 10) : 999999;
};

const extractSeriesSeasonKey = (text = "") => {
    const cleaned = stripChannelNoise(text)
        .replace(/\.part\d+/i, "")
        .replace(/\bS\d+E\d+.*$/i, "")
        .replace(/\bS\d+\s*EP.*$/i, "")
        .replace(/\b(2160p|4K|1440p|1080p|720p|480p|360p|240p)\b.*$/i, "")
        .replace(/[-–—|]+$/, "")
        .trim();
    return cleaned || "Series";
};

const extractSeasonTag = (text = "") => {
    const match = String(text).match(/\b(S\d+)\b/i);
    return match ? match[1].toUpperCase() : "S01";
};

const extractTitle = (text) => {
    const match = String(text || "").match(/^(.+?\(\d{4}\))/);
    if (match) return match[1].trim();
    const seriesKey = extractSeriesSeasonKey(text);
    if (seriesKey && seriesKey !== "Series") return seriesKey;
    return String(text || "Movie Collection").split('-')[0].trim();
};

// --- PAYLOAD COMPRESSION HELPERS (To bypass Telegram 64-char limit) ---
const compressIds = (ids) => {
    if (!ids || !ids.length) return "";
    const sorted = [...new Set(ids.map(Number).filter(n => !isNaN(n)))].sort((a, b) => a - b);
    if (!sorted.length) return "";

    let ranges = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === prev + 1) {
            prev = sorted[i];
        } else {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
            start = sorted[i];
            prev = sorted[i];
        }
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    return ranges.join('.');
};

const decompressIds = (str) => {
    if (!str) return [];
    let ids = [];
    const ranges = String(str).split('.');
    for (const r of ranges) {
        const bounds = r.split('-');
        if (bounds.length === 2) {
            const start = parseInt(bounds[0], 10);
            const end = parseInt(bounds[1], 10);
            if (!isNaN(start) && !isNaN(end) && end >= start) {
                for (let i = start; i <= end; i++) ids.push(i);
            }
        } else {
            const single = parseInt(bounds[0], 10);
            if (!isNaN(single)) ids.push(single);
        }
    }
    return ids;
};

const encodePayload = (idArray) => {
    const compressed = compressIds(idArray);
    if (!compressed) return "";
    const text = `C_${compressed}`;
    return Buffer.from(text)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
};

const decodePayload = (code) => {
    try {
        if (!code) return null;
        let base64 = String(code).replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        const text = Buffer.from(base64, 'base64').toString('utf-8');
        const parts = text.split('_');

        // New compressed array payload
        if (parts[0] === 'C' && parts[1]) {
            return decompressIds(parts[1]);
        }

        // Legacy single-file payload support
        if (parts[0] === 'File' && parts[2] === 'Secure') {
            const singleId = parseInt(parts[1], 10);
            return isNaN(singleId) ? null : [singleId];
        }

        return null;
    } catch (e) {
        return null;
    }
};

// --- BATCH & FILE HELPERS ---
const ensureUserStorage = (userId) => {
    if (!global.batchStorage[userId]) {
        global.batchStorage[userId] = {
            files: [],
            poster: null,
            episodeBatches: {}
        };
    }
    global.batchStorage[userId].episodeBatches = global.batchStorage[userId].episodeBatches || {};
    return global.batchStorage[userId];
};

const rebuildEpisodeBatchEntry = (ctx, userStorage, batchKey) => {
    const batch = userStorage.episodeBatches[batchKey];
    if (!batch || !batch.items.length) return;

    // Sort episodes ascending (e.g., E01 -> E02 ... -> E21)
    batch.items.sort((a, b) => a.epNum - b.epNum || a.msgId - b.msgId);

    const firstEp = String(batch.items[0].epNum).padStart(2, '0');
    const lastEp = String(batch.items[batch.items.length - 1].epNum).padStart(2, '0');
    const epRangeStr = firstEp === lastEp ? `EP (${firstEp})` : `EP (${firstEp}-${lastEp})`;

    const ids = batch.items.map(item => item.msgId);
    const code = encodePayload(ids);
    const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
    const formattedCaption = `${batch.series} ${batch.season} ${epRangeStr} [${batch.groupLabel}]`;

    let entry = userStorage.files.find(f => f.batchKey === batchKey);
    if (!entry) {
        entry = {
            batchKey,
            sortOrder: batch.sortOrder || 99,
            caption: formattedCaption,
            longLink,
            ids,
            isGrouped: true
        };
        userStorage.files.push(entry);
    } else {
        entry.caption = formattedCaption;
        entry.longLink = longLink;
        entry.ids = ids;
        entry.sortOrder = batch.sortOrder || entry.sortOrder || 99;
    }
};

const sendFiles = async (ctx, ids) => {
    let sentCount = 0;
    for (const id of ids) {
        try {
            await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id);
            sentCount++;
            await new Promise(r => setTimeout(r, 200)); // Anti-flood delay
        } catch (e) {}
    }
    if (sentCount === 0) {
        await ctx.reply(
            "<b>Files missing or Bot is not an Admin in the database channel.</b>",
            { parse_mode: 'HTML' }
        );
    }
};

// --- API FUNCTIONS ---
const getShortLink = async (longUrl) => {
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return null;
    try {
        const apiUrl = `https://${global.shortenerConfig.domain}/api?api=${encodeURIComponent(global.shortenerConfig.key)}&url=${encodeURIComponent(longUrl)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.status === 'success' || data.shortenedUrl) return data.shortenedUrl;
        return null;
    } catch (error) {
        return null;
    }
};

const uploadToImgbb = async (fileUrl) => {
    try {
        const apiKey = process.env.IMGBB_API_KEY;
        if (!apiKey) throw new Error("Missing IMGBB_API_KEY");

        const formData = new FormData();
        formData.append('image', fileUrl);

        const response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (data.success && data.data && data.data.url) return data.data.url;
        return null;
    } catch (e) {
        return null;
    }
};

const createTelegraphPage = async (title, nodes) => {
    try {
        if (!global.telegraphToken) {
            const accRes = await fetch(`https://api.telegra.ph/createAccount?short_name=StarFlix&author_name=@StarFlixTamil`);
            const accData = await accRes.json();
            if (accData.ok && accData.result && accData.result.access_token) {
                global.telegraphToken = accData.result.access_token;
            }
        }

        const contentStr = JSON.stringify(nodes);
        const params = new URLSearchParams();
        params.append('access_token', global.telegraphToken);
        params.append('title', title);
        params.append('author_name', '@StarFlixTamil');
        params.append('author_url', 'https://t.me/StarFlixTamil');
        params.append('content', contentStr);
        params.append('return_content', 'true');

        const response = await fetch('https://api.telegra.ph/createPage', {
            method: 'POST',
            body: params
        });

        const data = await response.json();
        if (data.ok && data.result && data.result.url) return data.result.url;
        return null;
    } catch (e) {
        return null;
    }
};

// --- KEYBOARDS ---
const getAdminKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`⚙️ Setup Shortener`, 'admin_shortener')],
        [Markup.button.callback(`📝 Create Graph Page`, 'batch_create_graph')],
        [Markup.button.callback(`❌ Clear Queue`, 'batch_clear')]
    ]);
};

const getJoinButtons = async (ctx, payload) => {
    const buttons = [];
    for (const id of FORCE_SUB_IDS) {
        try {
            const chat = await ctx.telegram.getChat(id);
            const link = chat.invite_link || (chat.username ? `https://t.me/${chat.username.replace('@', '')}` : null);
            if (link) {
                buttons.push([Markup.button.url(`Join ${chat.title}`, link)]);
            }
        } catch (e) {}
    }
    const cb = payload ? `checksub_${payload}` : 'checksub_home';
    buttons.push([Markup.button.callback('🔄 Verified / Try Again', cb)]);
    return Markup.inlineKeyboard(buttons);
};

// --- HANDLERS ---
bot.action('batch_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete global.batchStorage[ctx.from.id];
    await ctx.reply("<b>Queue Cleared!</b>", { parse_mode: 'HTML', ...getAdminKeyboard() });
});

bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.awaitingShortenerConfig[ctx.from.id] = true;
    await ctx.reply("<b>Send Shortener Config:\ndomain.com | api_key</b>", { parse_mode: 'HTML' });
});

bot.action('batch_create_graph', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Admin only');

    const userData = global.batchStorage[ctx.from.id];
    if (!userData || (!userData.files.length && !userData.poster)) {
        return ctx.reply("<b>Queue is empty. Send files and an image.</b>", { parse_mode: 'HTML' });
    }

    await ctx.reply("<b>Creating Page...</b>", { parse_mode: 'HTML' });

    const orderedFiles = [...userData.files].sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));

    const domNodes = [];
    const firstFileCaption = orderedFiles[0] ? orderedFiles[0].caption : "Movie Collection";
    const cleanTitle = extractTitle(firstFileCaption);

    if (userData.poster) {
        domNodes.push({
            tag: 'figure',
            children: [
                { tag: 'img', attrs: { src: userData.poster } },
                { tag: 'figcaption', children: [cleanTitle] }
            ]
        });
    }

    domNodes.push({ tag: 'p', children: [{ tag: 'b', children: ['Telegram Files'] }] });

    for (const file of orderedFiles) {
        const shortLink = (await getShortLink(file.longLink)) || file.longLink;
        domNodes.push({
            tag: 'p',
            children: [
                { tag: 'b', children: [file.caption] },
                { tag: 'br' },
                { tag: 'b', children: [{ tag: 'a', attrs: { href: shortLink }, children: [shortLink] }] }
            ]
        });
    }

    domNodes.push({ tag: 'br' });
    domNodes.push({
        tag: 'p',
        children: [{ tag: 'b', children: ['⭕️ Main Channel : @StarFlixTamil ⭕️'] }]
    });

    let graphUrl = await createTelegraphPage(cleanTitle, domNodes);
    if (graphUrl) {
        graphUrl = graphUrl.replace('telegra.ph', 'graph.org');
        await ctx.reply(
            `<b>Graph Page Ready!</b>\n\n<b>Link:</b> ${escapeHtml(graphUrl)}`,
            { parse_mode: 'HTML', disable_web_page_preview: false }
        );
        delete global.batchStorage[ctx.from.id];
    } else {
        await ctx.reply("<b>Failed to create Graph page.</b>", { parse_mode: 'HTML' });
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.reply("<b>Uploading Image to ImgBB...</b>", { parse_mode: 'HTML' });
    try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const imgUrl = await uploadToImgbb(fileLink.href);

        if (imgUrl) {
            const userStorage = ensureUserStorage(ctx.from.id);
            userStorage.poster = imgUrl;
            await ctx.reply("<b>Poster Set! Now send files.</b>", { parse_mode: 'HTML', ...getAdminKeyboard() });
        } else {
            await ctx.reply("<b>Upload Failed. Check API Key.</b>", { parse_mode: 'HTML' });
        }
    } catch (e) {
        await ctx.reply(`<b>Error: ${escapeHtml(e.message)}</b>`, { parse_mode: 'HTML' });
    }
});

bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (!ctx.from) return;
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("<b>Admin Only.</b>", { parse_mode: 'HTML' });

    try {
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const msgId = sent.message_id;

        const mediaObj = ctx.message.document || ctx.message.video || ctx.message.audio || {};
        const fileSize = mediaObj.file_size || 0;

        let rawCap = ctx.message.caption || mediaObj.file_name || "";
        const strippedRaw = stripChannelNoise(rawCap);
        const cleanBase = strippedRaw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|zip|rar|7z|part\d+)$/i, "").trim();
        const isPartFile = /\.(part\d+)$/i.test(strippedRaw.replace(/\.(mkv|mp4|avi|zip|rar)$/i, ""));

        const resTag = extractResolutionTag(strippedRaw);
        const seriesName = extractSeriesSeasonKey(strippedRaw);
        const seasonTag = extractSeasonTag(strippedRaw);
        const epNum = extractEpisodeNumber(strippedRaw);
        const sizeTier = getSizeTierLabel(fileSize);

        // Resolution tag irundhaal adhai use pannum; illaatti size tier (~300MB / ~1GB / ~1.4GB) use pannum
        const groupLabel = resTag || sizeTier;

        const resOrderMap = {
            '360p': 1,
            '480p': 2,
            '720p': 3,
            '1080p': 4,
            '1440p': 5,
            '2160p': 6,
            '4K': 6,
            '~300MB': 11,
            '~1GB': 12,
            '~1.4GB': 13,
            'Pack': 14
        };
        const sortOrder = resOrderMap[groupLabel] || 99;

        const userStorage = ensureUserStorage(ctx.from.id);
        const prevCount = userStorage.files.length;

        // 1. Multi-part split archive grouping (.part001, .part002, etc.)
        if (isPartFile) {
            const partBaseName = cleanBase.replace(/\.part\d+$/i, "").trim();
            let existingPartEntry = userStorage.files.find(f => f.partKey === partBaseName && f.isGrouped);

            if (existingPartEntry) {
                existingPartEntry.ids.push(msgId);
                const code = encodePayload(existingPartEntry.ids);
                existingPartEntry.longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
                await ctx.reply(
                    `<b>Added Part to: ${escapeHtml(partBaseName)}</b>\n<b>Total Parts Bundled: ${existingPartEntry.ids.length}</b>`,
                    { parse_mode: 'HTML' }
                );
                return;
            } else {
                const code = encodePayload([msgId]);
                const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
                userStorage.files.push({
                    partKey: partBaseName,
                    sortOrder: 0,
                    caption: partBaseName,
                    longLink,
                    ids: [msgId],
                    isGrouped: true
                });
            }
        }
        // 2. Series episode batching (Quality/Resolution irundhaal 360p/720p/1080p; illaatti ~300MB/~1GB/~1.4GB)
        else if (epNum !== 999999) {
            const batchKey = `${seriesName}__${seasonTag}__${groupLabel}`;
            if (!userStorage.episodeBatches[batchKey]) {
                userStorage.episodeBatches[batchKey] = {
                    series: seriesName,
                    season: seasonTag,
                    groupLabel,
                    sortOrder,
                    items: []
                };
            }
            userStorage.episodeBatches[batchKey].items.push({
                msgId,
                epNum,
                size: fileSize
            });
            rebuildEpisodeBatchEntry(ctx, userStorage, batchKey);
        }
        // 3. Single / non-episode file
        else {
            const formattedName = cleanCaption(rawCap, fileSize);
            const code = encodePayload([msgId]);
            const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
            userStorage.files.push({
                sortOrder: 50,
                caption: formattedName,
                longLink,
                ids: [msgId],
                isGrouped: false
            });
        }

        const count = userStorage.files.length;
        await ctx.reply(`<b>Added (${count})</b>`, { parse_mode: 'HTML' });

        if (prevCount === 0 && count >= 1) {
            await ctx.reply(
                "<b>Batch Started. Send all files, then click 'Create Graph Page'</b>",
                { parse_mode: 'HTML', ...getAdminKeyboard() }
            );
        }
    } catch (e) {
        await ctx.reply("<b>DB Channel Error. Ensure Bot is Admin in Channel.</b>", { parse_mode: 'HTML' });
    }
});

const checkForceSub = async (ctx, userId) => {
    if (!userId) return true;
    if (userId === ADMIN_ID) return true;
    if (FORCE_SUB_IDS.length === 0) return true;
    for (const channelId of FORCE_SUB_IDS) {
        try {
            const member = await ctx.telegram.getChatMember(channelId, userId);
            if (['left', 'kicked', 'restricted'].includes(member.status)) return false;
        } catch (err) {}
    }
    return true;
};

bot.action(/checksub_(.+)/, async (ctx) => {
    const pl = ctx.match[1];
    if (await checkForceSub(ctx, ctx.from.id)) {
        try { await ctx.deleteMessage(); } catch (e) {}
        if (pl !== 'home') {
            const ids = decodePayload(pl);
            if (ids && ids.length > 0) {
                await sendFiles(ctx, ids);
            }
        } else {
            await ctx.reply("<b>Welcome!</b>", { parse_mode: 'HTML' });
        }
    } else {
        await ctx.answerCbQuery('Join the channel first!', { show_alert: true });
    }
});

bot.start(async (ctx) => {
    try {
        const pl = ctx.payload;

        if (pl) {
            if (!await checkForceSub(ctx, ctx.from.id)) {
                return ctx.reply(
                    "<b>Access Denied. Please join the channel first.</b>",
                    { parse_mode: 'HTML', ...await getJoinButtons(ctx, pl) }
                );
            }
            const ids = decodePayload(pl);
            if (ids && ids.length > 0) {
                await sendFiles(ctx, ids);
            } else {
                await ctx.reply("<b>Invalid Link.</b>", { parse_mode: 'HTML' });
            }
            return;
        }

        if (ctx.from.id === ADMIN_ID) {
            const userData = global.batchStorage[ctx.from.id];
            const count = userData ? userData.files.length : 0;
            const hasPoster = userData && userData.poster ? "Set" : "Not Set";
            await ctx.reply(
                `<b>Admin Panel</b>\n<b>Files in Queue: ${count}</b>\n<b>Poster: ${hasPoster}</b>`,
                { parse_mode: 'HTML', ...getAdminKeyboard() }
            );
        } else {
            await ctx.reply("<b>Send me a valid link.</b>", { parse_mode: 'HTML' });
        }
    } catch (e) {
        console.error(e);
    }
});

bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    if (ctx.from.id === ADMIN_ID && global.awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text || "";
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            global.shortenerConfig = { domain, key };
            global.awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(
                `<b>Configured: ${escapeHtml(domain)}</b>`,
                { parse_mode: 'HTML', ...getAdminKeyboard() }
            );
        }
    }
});

export default async function handler(req, res) {
    if (req.method === 'POST') {
        if (!bot.botInfo) bot.botInfo = await bot.telegram.getMe();
        await bot.handleUpdate(req.body);
        return res.status(200).send('OK');
    }
    return res.status(200).send('Bot Active 🚀');
}
