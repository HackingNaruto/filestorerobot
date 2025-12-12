// api/bot.js
const { Telegraf, Markup } = require('telegraf');

// --- 1. CONFIGURATION (From Vercel Environment Variables) ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);

// Force Sub Channels: Get string "id1, id2" -> convert to Array [id1, id2]
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "")
    .split(',')
    .map(id => id.trim())
    .filter(id => id);

// --- 2. MEMORY STORAGE (Volatile - For Batching) ---
// Vercel serverless functions restart often, so finish batch uploads quickly.
let userModes = {};     // Stores 'single' or 'batch' for Admin
let batchStorage = {};  // Stores files temporarily

// --- 3. HELPER FUNCTIONS ---

// Encrypt Message ID to look like a Random Code
const encodePayload = (msgId) => {
    const text = `File_${msgId}_Secure`; 
    return Buffer.from(text).toString('base64').replace(/=/g, ''); 
};

// Decrypt Random Code back to Message ID
const decodePayload = (code) => {
    try {
        const text = Buffer.from(code, 'base64').toString('utf-8');
        const parts = text.split('_');
        if (parts[0] === 'File' && parts[2] === 'Secure') {
            return parseInt(parts[1]);
        }
        return null;
    } catch (error) {
        return null;
    }
};

// Get first 2 words for Grouping (Automation)
const getGroupId = (text) => {
    if (!text) return "Unknown";
    const words = text.split(' ');
    if (words.length >= 2) return `${words[0]} ${words[1]}`.toLowerCase();
    return words[0].toLowerCase();
};

// Check if User joined all Force Sub Channels
const checkForceSub = async (ctx, userId) => {
    if (userId === ADMIN_ID) return true; // Admin needs no check
    if (FORCE_SUB_IDS.length === 0) return true; // No channels configured

    for (const channelId of FORCE_SUB_IDS) {
        try {
            const member = await ctx.telegram.getChatMember(channelId, userId);
            if (['left', 'kicked', 'restricted'].includes(member.status)) {
                return false;
            }
        } catch (err) {
            console.error(`ForceSub Error for ${channelId}:`, err.message);
            return false; // Assume not joined if error (or bot not admin)
        }
    }
    return true;
};

// Generate "Join Channel" Buttons
const getJoinButtons = async (ctx, startPayload) => {
    const buttons = [];
    for (const channelId of FORCE_SUB_IDS) {
        try {
            const chat = await ctx.telegram.getChat(channelId);
            const link = chat.invite_link || `https://t.me/${chat.username.replace('@','')}`;
            buttons.push([Markup.button.url(`Join ${chat.title}`, link)]);
        } catch (e) {
            console.log(`Bot not admin in ${channelId}`);
        }
    }
    // "Try Again" button carries the file code (payload) so user gets file immediately after joining
    const callbackData = startPayload ? `checksub_${startPayload}` : 'checksub_home';
    buttons.push([Markup.button.callback('🔄 Try Again / Verified', callbackData)]);
    return Markup.inlineKeyboard(buttons);
};

// --- 4. COMMANDS & ADMIN LOGIC ---

// Toggle Mode: Single <-> Batch
bot.command('mode', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const currentMode = userModes[ctx.from.id] || 'single';
    const newMode = currentMode === 'single' ? 'batch' : 'single';
    userModes[ctx.from.id] = newMode;
    
    if (newMode === 'single') delete batchStorage[ctx.from.id]; // Clear memory
    
    await ctx.reply(`🔄 **Mode Changed!**\n\nCurrent Mode: **${newMode.toUpperCase()}**\n` + 
        (newMode === 'batch' ? 'Files will be stored. Use `/done` to publish.' : 'Files will be processed immediately.'));
});

// Process Batch (/done)
bot.command('done', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const files = batchStorage[ctx.from.id];
    if (!files || files.length === 0) return ctx.reply('⚠️ No files in batch.');

    await ctx.reply('⚙️ Processing Automation...');
    
    // Group files by First 2 Words
    const groups = {};
    files.forEach(file => {
        const name = file.caption || "Untitled";
        const groupKey = getGroupId(name);
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(file);
    });

    // Send Consolidated Messages
    for (const groupKey in groups) {
        let msgText = "";
        groups[groupKey].forEach(file => {
            // Sanitize caption for HTML
            const safeCaption = (file.caption || "File").replace(/<|>/g, '');
            msgText += `🔹 <a href="${file.link}">${safeCaption}</a>\n\n`;
        });

        try {
            await ctx.reply(msgText, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
            await ctx.reply(`❌ Error sending group: ${groupKey}`);
        }
    }

    delete batchStorage[ctx.from.id];
    await ctx.reply('✅ Automation Complete!');
});

// Admin File Upload Handler
bot.on(['document', 'video', 'audio'], async (ctx) => {
    // 1. Restriction: Only Admin can upload
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply('⛔ **Access Denied!** Only Admin can add files.');
    }

    try {
        const mode = userModes[ctx.from.id] || 'single';
        
        // A. Copy File to DB Channel (No Forward Tag)
        const sentMsg = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        
        // B. Generate Secret Link
        const secureCode = encodePayload(sentMsg.message_id);
        const shareLink = `https://t.me/${ctx.botInfo.username}?start=${secureCode}`;
        
        // Get Filename/Caption
        const msg = ctx.message;
        let displayName = msg.caption;
        if (!displayName) {
             if (msg.document) displayName = msg.document.file_name;
             else if (msg.video) displayName = msg.video.file_name || "Video";
             else if (msg.audio) displayName = msg.audio.file_name || "Audio";
        }

        // C. Handle Modes
        if (mode === 'single') {
            await ctx.reply(`✅ **Stored!**\n📂 ${displayName}\n🔗 ${shareLink}`, { disable_web_page_preview: true });
        } else {
            if (!batchStorage[ctx.from.id]) batchStorage[ctx.from.id] = [];
            batchStorage[ctx.from.id].push({ caption: displayName, link: shareLink });
        }

    } catch (error) {
        console.error(error);
        await ctx.reply('❌ Error: Check Channel ID & Bot Admin Rights.');
    }
});

// --- 5. USER INTERACTION & FORCE SUB ---

// Handle "Try Again" Button
bot.action(/checksub_(.+)/, async (ctx) => {
    const payload = ctx.match[1]; // Get 'home' or file code
    const isJoined = await checkForceSub(ctx, ctx.from.id);

    if (isJoined) {
        await ctx.deleteMessage(); // Delete the "Join" warning
        if (payload === 'checksub_home') {
            await ctx.reply('👋 Welcome! You are verified.');
        } else {
            // Deliver the file requested
            const msgId = decodePayload(payload);
            if (msgId) {
                try {
                    await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, msgId);
                } catch (e) { await ctx.reply('❌ File not found.'); }
            }
        }
    } else {
        await ctx.answerCbQuery('⚠️ You have not joined yet!', { show_alert: true });
    }
});

// Start Command
bot.start(async (ctx) => {
    const payload = ctx.payload;
    const isJoined = await checkForceSub(ctx, ctx.from.id);

    // If NOT Joined -> Show Force Sub Buttons
    if (!isJoined) {
        const buttons = await getJoinButtons(ctx, payload);
        return ctx.reply('⚠️ **Access Restricted**\n\nPlease join our channels to access files.', buttons);
    }

    // If Joined -> Process Request
    if (payload) {
        const msgId = decodePayload(payload);
        if (msgId) {
            try {
                // Copy without forward tag
                await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, msgId);
            } catch (error) { await ctx.reply('❌ File unavailable.'); }
        } else {
            await ctx.reply('❌ Invalid Link.');
        }
    } else {
        if (ctx.from.id === ADMIN_ID) {
            const mode = userModes[ctx.from.id] || 'single';
            await ctx.reply(`👋 **Admin Panel**\nCurrent Mode: ${mode.toUpperCase()}\n\n/mode - Switch Mode\n/done - Finish Batch`);
        } else {
            await ctx.reply('🤖 **File Store Bot**\nSend me a valid link to get files.');
        }
    }
});

// --- 6. VERCEL HANDLER ---
export default async function handler(req, res) {
    try {
        if (req.method === 'POST') {
            if(!bot.botInfo) bot.botInfo = await bot.telegram.getMe();
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot Active 🚀');
    } catch (e) {
        console.error(e);
        return res.status(500).send('Error');
    }
}
