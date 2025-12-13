const { Telegraf, Markup } = require('telegraf');
const FormData = require('form-data');
const axios = require('axios');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "").split(',').map(id => id.trim()).filter(id => id);

// --- MEMORY STORAGE (Global Vars for Vercel) ---
global.batchStorage = global.batchStorage || {}; 
global.shortenerConfig = global.shortenerConfig || {
    domain: process.env.SHORTENER_DOMAIN || "", 
    key: process.env.SHORTENER_KEY || ""
};
global.telegraphToken = global.telegraphToken || ""; 

// --- ERROR HANDLING (Prevents Crash) ---
bot.catch((err, ctx) => {
    console.error(`Bot Error:`, err);
    try {
        ctx.reply(`⚠️ <b>Error Occurred:</b>\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
    } catch(e) {}
});

// --- HELPERS ---
const encodePayload = (msgId) => {
    const text = `File_${msgId}_Secure`; 
    return Buffer.from(text).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); 
};

const decodePayload = (code) => {
    try {
        let base64 = code.replace(/-/g, '+').replace(/_/g, '/');
        const text = Buffer.from(base64, 'base64').toString('utf-8');
        const parts = text.split('_');
        if (parts[0] === 'File' && parts[2] === 'Secure') return parseInt(parts[1]);
        return null;
    } catch (e) { return null; }
};

const cleanCaption = (text) => {
    if (!text) return "Untitled File";
    let clean = String(text)
        .replace(/⭕️ Main Channel : @StarFlixTamil ⭕️/g, "")
        .replace(/(Main Channel|Join Channel).*/gi, "")
        .replace(/@[\w_]+/g, "");
    return clean.trim();
};

// --- API FUNCTIONS ---

// 1. URL Shortener (Axios)
const getShortLink = async (longUrl) => {
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return null;
    try {
        const apiUrl = `https://${global.shortenerConfig.domain}/api?api=${global.shortenerConfig.key}&url=${encodeURIComponent(longUrl)}`;
        const response = await axios.get(apiUrl);
        if (response.data.status === 'success' || response.data.shortenedUrl) return response.data.shortenedUrl;
        return null;
    } catch (error) { 
        console.error("Shortener Error:", error.message);
        return null; 
    }
};

// 2. Upload to Catbox (Robust Axios Method)
const uploadToCatbox = async (fileUrl) => {
    try {
        // Step A: Download Image
        const imageRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageRes.data);

        // Step B: Prepare Form
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

        // Step C: Upload with Correct Headers
        const response = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: {
                ...form.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        if (response.data && response.data.toString().startsWith('http')) {
            return response.data.trim();
        }
        return null;
    } catch (e) {
        console.error("Catbox Error:", e.message);
        throw new Error("Catbox Upload Failed: " + e.message);
    }
};

// 3. Create Telegraph Page
const createTelegraphPage = async (title, nodes) => {
    try {
        // Create Account if missing
        if (!global.telegraphToken) {
            const accRes = await axios.get(`https://api.telegra.ph/createAccount?short_name=FileBot&author_name=Admin`);
            if (accRes.data.ok) global.telegraphToken = accRes.data.result.access_token;
        }

        const contentStr = JSON.stringify(nodes);
        const params = new URLSearchParams();
        params.append('access_token', global.telegraphToken);
        params.append('title', title);
        params.append('content', contentStr);
        params.append('return_content', 'true');

        const response = await axios.post('https://api.telegra.ph/createPage', params);
        
        if (response.data.ok) return response.data.result.url;
        return null;
    } catch (e) {
        console.error("Telegraph Error:", e.message);
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

// --- HANDLERS ---

bot.action('batch_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete global.batchStorage[ctx.from.id];
    await ctx.reply("🗑 Queue Cleared!", getAdminKeyboard());
});

bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.awaitingShortenerConfig[ctx.from.id] = true;
    await ctx.reply(`⚙️ Send Shortener Config:\ndomain.com | api_key`);
});

// --- 🔥 CREATE GRAPH PAGE 🔥 ---
bot.action('batch_create_graph', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');

    const userData = global.batchStorage[ctx.from.id];
    if (!userData || (!userData.files.length && !userData.poster)) {
        return ctx.reply('⚠️ Queue empty. Send files and an image.');
    }

    await ctx.reply("⏳ Processing... Creating Page (Please Wait)...");

    let domNodes = [];

    // --- POSTER ---
    if (userData.poster) {
        domNodes.push({
            tag: 'img',
            attrs: { src: userData.poster }
        });
        domNodes.push({ tag: 'br' });
    }

    // --- HEADER ---
    domNodes.push({ tag: 'h4', children: ['🔻 DOWNLOAD LINKS 🔻'] });
    domNodes.push({ tag: 'hr' });

    // --- FILES ---
    for (const file of userData.files) {
        // Shorten Link
        let linkToUse = file.longLink;
        const shortLink = await getShortLink(file.longLink);
        if (shortLink) linkToUse = shortLink;
        
        // Movie Title (Bold)
        domNodes.push({ 
            tag: 'b', 
            children: [`📂 ${file.caption}`] 
        });
        domNodes.push({ tag: 'br' });

        // Download Button/Link
        domNodes.push({ 
            tag: 'a', 
            attrs: { href: linkToUse }, 
            children: ['📥 ᴄʟɪᴄᴋ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ / ᴡᴀᴛᴄʜ'] 
        });

        domNodes.push({ tag: 'br' });
        domNodes.push({ tag: 'br' });
    }

    // --- FOOTER ---
    domNodes.push({ tag: 'hr' });
    domNodes.push({ tag: 'i', children: ['Join our Telegram Channel'] });

    const pageTitle = userData.files[0] ? userData.files[0].caption.split(' - ')[0] : "Movie Collection";
    
    const graphUrl = await createTelegraphPage(pageTitle, domNodes);

    if (graphUrl) {
        await ctx.reply(`✅ **Graph Page Ready!**\n\n🔗 ${graphUrl}`, { disable_web_page_preview: false });
        delete global.batchStorage[ctx.from.id];
    } else {
        await ctx.reply("❌ Failed to create Graph page. Check logs.");
    }
});


// --- UPLOAD HANDLERS ---

// 1. Handle POSTER
bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    await ctx.reply("🖼 Uploading to Catbox...");

    try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        
        // Upload (If this fails, bot.catch will catch it)
        const catboxUrl = await uploadToCatbox(fileLink.href);

        if (catboxUrl) {
            if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = { files: [], poster: null };
            global.batchStorage[ctx.from.id].poster = catboxUrl;
            
            await ctx.reply(`✅ **Poster Set!**\nNow send files.`, getAdminKeyboard());
        } else {
            await ctx.reply("❌ Catbox Upload Failed.");
        }
    } catch (e) {
        // Error is handled by bot.catch, but reply here for user awareness
        ctx.reply(`❌ Error: ${e.message}`);
    }
});

// 2. Handle FILES
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (!ctx.from) return; 
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    
    try {
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const code = encodePayload(sent.message_id);
        const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        
        let rawCap = ctx.message.caption || "";
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";
        const safeName = cleanCaption(rawCap);

        if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = { files: [], poster: null };
        
        global.batchStorage[ctx.from.id].files.push({
            caption: safeName,
            longLink: longLink
        });

        const count = global.batchStorage[ctx.from.id].files.length;
        if (count === 1) {
            await ctx.reply(`📥 **Batch Started.**\n\nSend Image -> Send Files -> Click 'Create Graph'`, getAdminKeyboard());
        }

    } catch (e) { ctx.reply('❌ DB Channel Error.'); }
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
        await ctx.deleteMessage();
        if (pl !== 'checksub_home') {
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e){}
        } else await ctx.reply('👋 Welcome!');
    } else await ctx.answerCbQuery('⚠️ Join first!', { show_alert: true });
});

bot.start(async (ctx) => {
    try {
        const pl = ctx.payload;
        if (pl) {
            if (!await checkForceSub(ctx, ctx.from.id)) return ctx.reply('⚠️ Access Denied', { ...await getJoinButtons(ctx, pl) });
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File missing.'); }
            else ctx.reply('❌ Invalid Link.');
            return;
        }
        if (ctx.from.id === ADMIN_ID) {
            const userData = global.batchStorage[ctx.from.id];
            const count = userData ? userData.files.length : 0;
            const hasPoster = userData && userData.poster ? "✅ Set" : "❌ Not Set";
            await ctx.reply(`👋 <b>Admin Panel</b>\nFiles: ${count}\nPoster: ${hasPoster}`, { parse_mode: 'HTML', ...getAdminKeyboard() });
        } else {
            ctx.reply('🤖 Send me a link.');
        }
    } catch (e) {}
});

bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    if (ctx.from.id === ADMIN_ID && global.awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text;
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            global.shortenerConfig = { domain, key };
            global.awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(`✅ Configured: ${domain}`, getAdminKeyboard());
        }
    }
});

// Vercel Handler (Standard)
export default async function handler(req, res) {
    try {
        if (req.method === 'POST') {
            if(!bot.botInfo) bot.botInfo = await bot.telegram.getMe();
            await bot.handleUpdate(req.body);
            // Respond 200 OK immediately to prevent Telegram retries
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot Active 🚀');
    } catch (e) {
        console.error(e);
        return res.status(500).send('Error');
    }
}

const getJoinButtons = async (ctx, payload) => {
    const buttons = [];
    for (const id of FORCE_SUB_IDS) {
        try {
            const chat = await ctx.telegram.getChat(id);
            const link = chat.invite_link || `https://t.me/${chat.username.replace('@','')}`;
            buttons.push([Markup.button.url(`Join ${chat.title}`, link)]);
        } catch (e) {}
    }
    const cb = payload ? `checksub_${payload}` : 'checksub_home';
    buttons.push([Markup.button.callback('🔄 Verified / Try Again', cb)]);
    return Markup.inlineKeyboard(buttons);
};
