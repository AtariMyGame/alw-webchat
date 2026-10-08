const express = require("express");
const path = require("path");
const net = require("net");
const fs = require("fs");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();

const PORT = process.env.PORT || 6187;

/*
============================================================
aLw IRC BOT + WEBCHAT
============================================================
*/

const BOT_NICK = "aLwSc";
const BOT_USER = "aLw
const BOT_REALNAME = "aLw WebChat IRC Bot";

const IRC_HOST = "irc.dal.net";
const IRC_PORT = 6667;

const OWNER = "F4R1S";

const CHANNEL_DB = path.join(__dirname, "channels.json");

let ircSocket = null;
let ircBuffer = "";
let ircConnected = false;
let ircRegistered = false;
let reconnectTimer = null;
let reconnectDelay = 5000;

let channels = [];

/*
============================================================
CHANNEL DATABASE
============================================================
*/

function loadChannels() {
    try {
        if (fs.existsSync(CHANNEL_DB)) {
            const data = JSON.parse(fs.readFileSync(CHANNEL_DB, "utf8"));

            if (Array.isArray(data)) {
                channels = data;
            }
        }
    } catch (err) {
        console.log("Gagal membaca channels.json:", err.message);
        channels = [];
    }
}

function saveChannels() {
    try {
        fs.writeFileSync(
            CHANNEL_DB,
            JSON.stringify(channels, null, 2)
        );
    } catch (err) {
        console.log("Gagal menyimpan channels.json:", err.message);
    }
}

loadChannels();

/*
============================================================
WEBCHAT
============================================================
*/

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

const wss = new WebSocketServer({
    server
});

const webUsers = new Map();

function broadcast(data) {
    const message = JSON.stringify(data);

    for (const ws of wss.clients) {
        if (ws.readyState === 1) {
            try {
                ws.send(message);
            } catch (_) {}
        }
    }
}

function webMessage(nick, message) {
    broadcast({
        type: "message",
        nick,
        message,
        time: new Date().toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit"
        })
    });
}

wss.on("connection", (ws) => {

    const defaultNick = "WebUser" + Math.floor(Math.random() * 9999);

    webUsers.set(ws, defaultNick);

    ws.send(JSON.stringify({
        type: "system",
        message: `Terhubung ke aLw WebChat sebagai ${defaultNick}`
    }));

    if (ircConnected) {
        ws.send(JSON.stringify({
            type: "system",
            message: "aLw sedang terhubung ke DALnet."
        }));
    } else {
        ws.send(JSON.stringify({
            type: "system",
            message: "aLw sedang menghubungkan ke DALnet..."
        }));
    }

    ws.on("message", (raw) => {

        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch (_) {
            return;
        }

        if (!data || typeof data !== "object") {
            return;
        }

        /*
        --------------------------------------------------------
        NICK WEBCHAT
        --------------------------------------------------------
        */

        if (data.type === "nick") {

            let nick = String(data.nick || "").trim();

            if (!nick) {
                return;
            }

            nick = nick.replace(/[^A-Za-z0-9_\-\[\]\\`^{}|]/g, "");

            if (!nick) {
                return;
            }

            if (nick.length > 16) {
                nick = nick.substring(0, 16);
            }

            webUsers.set(ws, nick);

            ws.send(JSON.stringify({
                type: "system",
                message: `Nick kamu sekarang ${nick}`
            }));

            return;
        }

        /*
        --------------------------------------------------------
        CHAT WEB -> IRC
        --------------------------------------------------------
        */

        if (data.type === "message") {

            const message = String(data.message || "").trim();

            if (!message) {
                return;
            }

            const nick = webUsers.get(ws) || "WebUser";

            /*
             * Command dari WebChat
             */

            if (message.startsWith("/")) {
                handleWebCommand(nick, message, ws);
                return;
            }

            /*
             * Kirim ke channel pertama
             */

            if (channels.length === 0) {

                ws.send(JSON.stringify({
                    type: "system",
                    message: "Bot belum memiliki channel. Owner gunakan +chan #channel."
                }));

                return;
            }

            const channel = channels[0];

            sendIRC(`PRIVMSG ${channel} :[Web] <${nick}> ${message}`);

            /*
             * Tampilkan juga ke WebChat
             */

            webMessage(nick, message);
        }
    });

    ws.on("close", () => {
        webUsers.delete(ws);
    });
});

/*
============================================================
IRC SEND
============================================================
*/

function sendIRC(line) {

    if (!ircSocket || !ircConnected) {
        console.log("IRC belum terhubung:", line);
        return false;
    }

    try {
        ircSocket.write(line + "\r\n");
        return true;
    } catch (err) {
        console.log("IRC write error:", err.message);
        return false;
    }
}

/*
============================================================
IRC CONNECTION
============================================================
*/

function connectIRC() {

    if (ircSocket) {
        try {
            ircSocket.destroy();
        } catch (_) {}
    }

    console.log(`Menghubungkan ke DALnet ${IRC_HOST}:${IRC_PORT}...`);

    ircSocket = new net.Socket();

    ircSocket.setTimeout(0);

    ircSocket.connect(
        IRC_PORT,
        IRC_HOST,
        () => {

            console.log("Terhubung ke DALnet.");

            ircConnected = true;
            ircRegistered = false;
            ircBuffer = "";
            reconnectDelay = 5000;

            sendIRC(`NICK ${BOT_NICK}`);
            sendIRC(`USER ${BOT_USER} 0 * :${BOT_REALNAME}`);

            broadcast({
                type: "system",
                message: "aLw terhubung ke DALnet."
            });
        }
    );

    ircSocket.on("data", (data) => {

        ircBuffer += data.toString();

        let index;

        while ((index = ircBuffer.indexOf("\r\n")) !== -1) {

            const line = ircBuffer.substring(0, index);

            ircBuffer = ircBuffer.substring(index + 2);

            if (line) {
                handleIRCLine(line);
            }
        }
    });

    ircSocket.on("error", (err) => {

        console.log("IRC ERROR:", err.message);

        ircConnected = false;
    });

    ircSocket.on("close", () => {

        console.log("Koneksi IRC terputus.");

        ircConnected = false;
        ircRegistered = false;
        ircSocket = null;

        broadcast({
            type: "system",
            message: "Koneksi DALnet terputus. Mencoba reconnect..."
        });

        scheduleReconnect();
    });
}

/*
============================================================
RECONNECT
============================================================
*/

function scheduleReconnect() {

    if (reconnectTimer) {
        return;
    }

    reconnectTimer = setTimeout(() => {

        reconnectTimer = null;

        connectIRC();

    }, reconnectDelay);

    reconnectDelay = Math.min(
        reconnectDelay * 2,
        60000
    );
}

/*
============================================================
IRC PARSER
============================================================
*/

function handleIRCLine(line) {

    console.log("[IRC]", line);

    /*
    PING
    */

    if (line.startsWith("PING ")) {

        const payload = line.substring(5);

        sendIRC(`PONG ${payload}`);

        return;
    }

    let prefix = "";
    let command = "";
    let params = [];

    let rest = line;

    if (rest.startsWith(":")) {

        const space = rest.indexOf(" ");

        if (space === -1) {
            return;
        }

        prefix = rest.substring(1, space);

        rest = rest.substring(space + 1);
    }

    const colon = rest.indexOf(" :");

    if (colon !== -1) {

        const before = rest.substring(0, colon);
        const trailing = rest.substring(colon + 2);

        params = before.split(" ").filter(Boolean);
        params.push(trailing);

    } else {

        params = rest.split(" ").filter(Boolean);
    }

    command = params.shift();

    if (!command) {
        return;
    }

    /*
    --------------------------------------------------------
    REGISTERED
    --------------------------------------------------------
    */

    if (command === "001") {

        ircRegistered = true;

        console.log("Bot berhasil login/register ke DALnet.");

        broadcast({
            type: "system",
            message: "aLw berhasil terhubung ke DALnet."
        });

        joinSavedChannels();

        return;
    }

    /*
    --------------------------------------------------------
    NICK
    --------------------------------------------------------
    */

    if (command === "433") {

        console.log("Nick aLw sedang digunakan.");

        const newNick =
            "aLw" +
            Math.floor(Math.random() * 99);

        sendIRC(`NICK ${newNick}`);

        return;
    }

    /*
    --------------------------------------------------------
    JOIN
    --------------------------------------------------------
    */

    if (command === "JOIN") {

        const nick = getNick(prefix);
        const channel = params[0];

        if (channel) {

            broadcast({
                type: "join",
                nick,
                channel
            });
        }

        return;
    }

    /*
    --------------------------------------------------------
    PART / QUIT
    --------------------------------------------------------
    */

    if (command === "PART" || command === "QUIT") {

        const nick = getNick(prefix);

        broadcast({
            type: "part",
            nick
        });

        return;
    }

    /*
    --------------------------------------------------------
    PRIVMSG
    --------------------------------------------------------
    */

    if (command === "PRIVMSG") {

        const nick = getNick(prefix);

        const target = params[0];
        const message = params[1] || "";

        if (!target) {
            return;
        }

        /*
        Pesan channel
        */

        if (target.startsWith("#")) {

            handleIRCMessage(
                nick,
                target,
                message
            );

            return;
        }

        /*
        Private message
        */

        broadcast({
            type: "private",
            nick,
            message
        });

        return;
    }

    /*
    --------------------------------------------------------
    NOTICE
    --------------------------------------------------------
    */

    if (command === "NOTICE") {

        const nick = getNick(prefix);
        const message = params[1] || "";

        broadcast({
            type: "notice",
            nick,
            message
        });

        return;
    }

    /*
    --------------------------------------------------------
    TOPIC
    --------------------------------------------------------
    */

    if (command === "332") {

        const channel = params[1];
        const topic = params[2] || "";

        broadcast({
            type: "topic",
            channel,
            topic
        });

        return;
    }

    /*
    --------------------------------------------------------
    NAMES
    --------------------------------------------------------
    */

    if (command === "353") {

        const channel = params[2];
        const names = params[3] || "";

        broadcast({
            type: "names",
            channel,
            names
        });

        return;
    }

    /*
    --------------------------------------------------------
    KICK
    --------------------------------------------------------
    */

    if (command === "KICK") {

        const channel = params[0];
        const nick = params[1];
        const reason = params[2] || "";

        broadcast({
            type: "kick",
            channel,
            nick,
            reason
        });

        return;
    }
}

/*
============================================================
GET NICK
============================================================
*/

function getNick(prefix) {

    if (!prefix) {
        return "";
    }

    return prefix.split("!")[0];
}

/*
============================================================
IRC MESSAGE
============================================================
*/

function handleIRCMessage(nick, channel, message) {

    webMessage(nick, message);

    /*
    Command IRC
    */

    handleBotCommand(
        nick,
        channel,
        message
    );
}

/*
============================================================
BOT COMMANDS
============================================================
*/

function isOwner(nick) {

    return nick.toLowerCase() === OWNER.toLowerCase();
}

function botSay(channel, message) {

    sendIRC(
        `PRIVMSG ${channel} :${message}`
    );
}

function botNotice(nick, message) {

    sendIRC(
        `NOTICE ${nick} :${message}`
    );
}

function handleBotCommand(nick, channel, message) {

    const text = message.trim();

    /*
    +chan
    */

    if (text.startsWith("+chan ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const newChannel =
            text.substring(6).trim();

        if (!/^#[A-Za-z0-9_\-\[\]\\`^{}|]+$/.test(newChannel)) {

            botNotice(nick, "Format: +chan #channel");
            return;
        }

        if (!channels.includes(newChannel)) {

            channels.push(newChannel);

            saveChannels();

            sendIRC(`JOIN ${newChannel}`);

            botSay(
                channel,
                `${newChannel} ditambahkan dan aLw akan join.`
            );

        } else {

            botSay(
                channel,
                `${newChannel} sudah ada di daftar channel.`
            );
        }

        return;
    }

    /*
    -chan
    */

    if (text.startsWith("-chan ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const oldChannel =
            text.substring(6).trim();

        if (!channels.includes(oldChannel)) {

            botSay(
                channel,
                `${oldChannel} tidak ada di daftar.`
            );

            return;
        }

        channels =
            channels.filter(
                c => c.toLowerCase() !== oldChannel.toLowerCase()
            );

        saveChannels();

        sendIRC(`PART ${oldChannel} :Leaving channel`);

        botSay(
            channel,
            `${oldChannel} dihapus dari daftar channel.`
        );

        return;
    }

    /*
    .chans
    */

    if (text === ".chans") {

        if (channels.length === 0) {

            botSay(
                channel,
                "Belum ada channel."
            );

            return;
        }

        botSay(
            channel,
            `Channel: ${channels.join(" | ")}`
        );

        return;
    }

    /*
    .rejoin
    */

    if (text.startsWith(".rejoin ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(8).trim();

        sendIRC(`PART ${target} :Rejoin`);
        setTimeout(() => {
            sendIRC(`JOIN ${target}`);
        }, 2000);

        return;
    }

    /*
    .say
    */

    if (text.startsWith(".say ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const msg =
            text.substring(5).trim();

        botSay(channel, msg);

        return;
    }

    /*
    .msg
    */

    if (text.startsWith(".msg ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const parts =
            text.substring(5).trim().split(" ");

        const target = parts.shift();
        const msg = parts.join(" ");

        if (target && msg) {

            sendIRC(
                `PRIVMSG ${target} :${msg}`
            );
        }

        return;
    }

    /*
    .notice
    */

    if (text.startsWith(".notice ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const parts =
            text.substring(8).trim().split(" ");

        const target = parts.shift();
        const msg = parts.join(" ");

        if (target && msg) {
            botNotice(target, msg);
        }

        return;
    }

    /*
    .kick
    */

    if (text.startsWith(".kick ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const parts =
            text.substring(6).trim().split(" ");

        const target = parts.shift();
        const reason =
            parts.join(" ") || "Kicked by aLw";

        if (target) {

            sendIRC(
                `KICK ${channel} ${target} :${reason}`
            );
        }

        return;
    }

    /*
    .ban
    */

    if (text.startsWith(".ban ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(5).trim();

        if (target) {

            sendIRC(
                `MODE ${channel} +b ${target}`
            );

            sendIRC(
                `KICK ${channel} ${target} :Banned by aLw`
            );
        }

        return;
    }

    /*
    .unban
    */

    if (text.startsWith(".unban ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(7).trim();

        if (target) {

            sendIRC(
                `MODE ${channel} -b ${target}`
            );
        }

        return;
    }

    /*
    .op
    */

    if (text.startsWith(".op ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(4).trim();

        if (target) {
            sendIRC(
                `MODE ${channel} +o ${target}`
            );
        }

        return;
    }

    /*
    .deop
    */

    if (text.startsWith(".deop ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(6).trim();

        if (target) {
            sendIRC(
                `MODE ${channel} -o ${target}`
            );
        }

        return;
    }

    /*
    .voice
    */

    if (text.startsWith(".voice ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(7).trim();

        if (target) {
            sendIRC(
                `MODE ${channel} +v ${target}`
            );
        }

        return;
    }

    /*
    .devoice
    */

    if (text.startsWith(".devoice ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(9).trim();

        if (target) {
            sendIRC(
                `MODE ${channel} -v ${target}`
            );
        }

        return;
    }

    /*
    .topic
    */

    if (text.startsWith(".topic ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const topic =
            text.substring(7).trim();

        sendIRC(
            `TOPIC ${channel} :${topic}`
        );

        return;
    }

    /*
    .invite
    */

    if (text.startsWith(".invite ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const target =
            text.substring(8).trim();

        if (target) {

            sendIRC(
                `INVITE ${target} ${channel}`
            );
        }

        return;
    }

    /*
    .mode
    */

    if (text.startsWith(".mode ")) {

        if (!isOwner(nick)) {
            botNotice(nick, "Command ini khusus owner.");
            return;
        }

        const mode =
            text.substring(6).trim();

        if (mode) {

            sendIRC(
                `MODE ${channel} ${mode}`
            );
        }

        return;
    }

    /*
    .status
    */

    if (text === ".status") {

        botSay(
            channel,
            `aLw: ${ircConnected ? "ONLINE" : "OFFLINE"} | Channels: ${channels.length}`
        );

        return;
    }

    /*
    .ping
    */

    if (text === ".ping") {

        botSay(
            channel,
            "PONG 🏓"
        );

        return;
    }

    /*
    .uptime
    */

    if (text === ".uptime") {

        const seconds =
            Math.floor(process.uptime());

        const hours =
            Math.floor(seconds / 3600);

        const minutes =
            Math.floor((seconds % 3600) / 60);

        const secs =
            seconds % 60;

        botSay(
            channel,
            `Uptime: ${hours}j ${minutes}m ${secs}d`
        );

        return;
    }

    /*
    .help
    */

    if (text === ".help") {

        botSay(
            channel,
            "Command: +chan #chan | -chan #chan | .chans | .rejoin #chan | .say teks | .msg nick teks | .notice nick teks | .kick nick | .ban nick | .unban nick | .op nick | .deop nick | .voice nick | .devoice nick | .topic teks | .invite nick | .mode mode | .status | .ping | .uptime"
        );

        return;
    }
}

/*
============================================================
WEBCHAT COMMAND
============================================================
*/

function handleWebCommand(nick, message, ws) {

    const text = message.substring(1).trim();

    if (!text) {
        return;
    }

    /*
     * WebChat user tidak dianggap sebagai IRC owner.
     * Command administrasi hanya bisa dijalankan
     * setelah nick IRC owner F4R1S.
     */

    if (text === "status") {

        ws.send(JSON.stringify({
            type: "system",
            message: `DALnet: ${ircConnected ? "ONLINE" : "OFFLINE"} | Channel: ${channels.length}`
        }));

        return;
    }

    if (text === "help") {

        ws.send(JSON.stringify({
            type: "system",
            message: "/status untuk melihat status | Chat biasa dikirim ke channel IRC."
        }));

        return;
    }

    ws.send(JSON.stringify({
        type: "system",
        message: "Command WebChat tidak tersedia atau membutuhkan owner IRC."
    }));
}

/*
============================================================
JOIN SAVED CHANNELS
============================================================
*/

function joinSavedChannels() {

    if (!ircRegistered) {
        return;
    }

    for (const channel of channels) {

        setTimeout(() => {

            console.log("JOIN", channel);

            sendIRC(
                `JOIN ${channel}`
            );

        }, 1000);
    }
}

/*
============================================================
START SERVER
============================================================
*/

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `aLw WebChat berjalan di port ${PORT}`
        );

        console.log(
            `aLw IRC Bot target: ${IRC_HOST}:${IRC_PORT}`
        );

        connectIRC();
    }
);
