```js
"use strict";

const irc = require("irc");
const net = require("net");
const { execFile } = require("child_process");
const dns = require("dns").promises;

const CONFIG = {
  server: "halcyon.dal.net",
  nick: "aLwSc",
  username: "aLwSc",
  realName: "aLwsc WebChat IRC Bot",
  channels: ["#alowaini"],

  // kalau perlu:
  // password: "NickServPass",
  // sasl: true,
};

const OWNER = "F4R1S";

const client = new irc.Client(CONFIG.server, CONFIG.nick, {
  userName: CONFIG.username,
  realName: CONFIG.realName,
  channels: CONFIG.channels,
  autoConnect: true,
  retryCount: 999,
  retryDelay: 3000,
  floodProtection: true,
  floodProtectionDelay: 750,
});


// ============================================================
// BASIC OUTPUT
// ============================================================

function say(target, msg) {
  const max = 420;

  if (msg.length <= max) {
    return client.say(target, msg);
  }

  client.say(target, msg.slice(0, max - 3) + "...");
}


function sayChunked(target, prefix, items) {
  const max = 420;
  let line = prefix;

  for (const it of items) {
    const add = (line === prefix) ? it : ` ${it}`;

    if ((line + add).length > max) {
      say(target, line);
      line = prefix + it;
    } else {
      line += add;
    }
  }

  if (line !== prefix) {
    say(target, line);
  }
}


// ============================================================
// OWNER CHECK
// ============================================================

function isOwner(nick) {
  return String(nick || "").toLowerCase() === OWNER.toLowerCase();
}


// ============================================================
// VALIDATION
// ============================================================

function isDomain(s) {
  if (!s || s.length > 253) return false;

  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(s);
}


function isHost(s) {
  if (!s || s.length > 253) return false;

  if (isDomain(s)) return true;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return true;
  }

  if (/^[0-9a-f:]+$/i.test(s) && s.includes(":")) {
    return true;
  }

  return false;
}


function isIP(s) {
  if (!s) return false;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return true;
  }

  if (/^[0-9a-f:]+$/i.test(s) && s.includes(":")) {
    return true;
  }

  return false;
}


function isChannel(s) {
  return typeof s === "string" && /^#[^\s,]+$/.test(s);
}


function looksLikeNick(s) {
  return !!s &&
    !isIP(s) &&
    !isDomain(s) &&
    !s.includes(" ");
}


// ============================================================
// HOST + PORT
// ============================================================

function parseHostPort(args) {
  if (!args || args.length === 0) {
    return null;
  }

  if (args.length >= 2) {
    const host = args[0];
    const port = Number(args[1]);

    if (
      !isHost(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return null;
    }

    return { host, port };
  }

  const one = args[0];

  const m = one.match(/^(.+):(\d{1,5})$/);

  if (!m) {
    return null;
  }

  const host = m[1];
  const port = Number(m[2]);

  if (
    !isHost(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }

  return { host, port };
}


// ============================================================
// COMMAND EXECUTOR
// ============================================================

function runCmd(bin, args, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
      },
      (err, stdout, stderr) => {

        const out = String(stdout || "");
        const errOut = String(stderr || "");

        const combined = (
          out +
          (errOut ? "\n" + errOut : "")
        ).trim();

        if (combined) {
          return resolve(combined);
        }

        if (err) {
          return reject(err);
        }

        resolve("");
      }
    );
  });
}


// ============================================================
// DNS
// ============================================================

async function resolveDomainToAllIPs(name) {
  let v4 = [];
  let v6 = [];

  try {
    v4 = await dns.resolve4(name);
  } catch (_) {}

  try {
    v6 = await dns.resolve6(name);
  } catch (_) {}

  const out = [];
  const seen = new Set();

  for (const ip of [...v4, ...v6]) {
    if (!seen.has(ip)) {
      seen.add(ip);
      out.push(ip);
    }
  }

  return out;
}


// ============================================================
// GET HOST FROM IRC NICK
// ============================================================

function getNickHost(nick) {
  return new Promise((resolve, reject) => {

    const wanted = nick.toLowerCase();

    const onRaw = (msg) => {

      const cmd = String(msg.command || "").toLowerCase();
      const p = msg.args || [];

      const targetNick = (p[1] || "").toLowerCase();

      if (
        (cmd === "311" || cmd === "rpl_whoisuser") &&
        targetNick === wanted
      ) {

        const host = p[3];

        cleanup();

        if (host) {
          return resolve(host);
        }

        return reject(new Error("host kosong"));
      }


      if (
        (cmd === "318" || cmd === "rpl_endofwhois") &&
        targetNick === wanted
      ) {

        cleanup();

        reject(new Error("host tidak ketemu"));
      }
    };


    const cleanup = () => {
      client.removeListener("raw", onRaw);
      clearTimeout(tmo);
    };


    client.addListener("raw", onRaw);

    client.send("WHOIS", nick, nick);


    const tmo = setTimeout(() => {

      cleanup();

      reject(new Error("WHOIS timeout"));

    }, 6000);
  });
}


// ============================================================
// .DNS
// ============================================================

async function cmdDns(target, q) {

  if (!q) {
    return say(target, "Pakai: .dns <host|ip|nick>");
  }

  let query = q;


  if (looksLikeNick(q)) {

    try {
      query = await getNickHost(q);

    } catch (e) {

      return say(
        target,
        `[DNS] ${q}: gagal ambil host (${e.message})`
      );
    }
  }


  const askingForPtr = isIP(query);


  try {

    const out = await runCmd(
      "nslookup",
      [query],
      9000
    );


    const lines = out
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);


    const ips = [];
    const ptrNames = [];

    const seenIP = new Set();
    const seenPTR = new Set();


    for (const line of lines) {

      const lower = line.toLowerCase();

      if (lower.includes("canonical name")) {
        continue;
      }


      const mPTR = line.match(
        /\bname\s*=\s*([^\s]+)\s*$/i
      );


      if (mPTR) {

        const n = mPTR[1].replace(/\.$/, "");

        if (!seenPTR.has(n)) {

          seenPTR.add(n);
          ptrNames.push(n);
        }

        continue;
      }


      const mAddr = line.match(
        /^Address:\s*(.+)$/i
      );


      if (mAddr) {

        if (mAddr[1].includes("#53")) {
          continue;
        }


        const v = mAddr[1]
          .trim()
          .split(/\s+/)[0];


        if (
          isIP(v) &&
          v !== query &&
          !seenIP.has(v)
        ) {

          seenIP.add(v);
          ips.push(v);
        }

        continue;
      }
    }


    const prefix =
      (query !== q)
        ? `[DNS] ${q} -> ${query}: `
        : `[DNS] ${q}: `;


    if (askingForPtr && ptrNames.length) {

      return sayChunked(
        target,
        prefix,
        ptrNames
      );
    }


    if (ips.length) {

      return sayChunked(
        target,
        prefix,
        ips
      );
    }


    if (ptrNames.length) {

      return sayChunked(
        target,
        prefix,
        ptrNames
      );
    }


    if (ips.length) {

      return sayChunked(
        target,
        prefix,
        ips
      );
    }


    say(
      target,
      `${prefix}(tidak ada hasil)`
    );

  } catch (e) {

    say(
      target,
      `[DNS] ${q}: gagal (${e.message})`
    );
  }
}


// ============================================================
// .PORT
// ============================================================

async function cmdPort(target, host, port) {

  return new Promise((resolve) => {

    const timeoutMs = 4000;

    const socket = new net.Socket();

    let done = false;


    const finish = (msg) => {

      if (done) {
        return;
      }

      done = true;

      socket.destroy();

      say(target, msg);

      resolve();
    };


    socket.setTimeout(timeoutMs);


    socket.once("connect", () => {

      finish(
        `[PORT] ${host}:${port} => OPEN`
      );
    });


    socket.once("timeout", () => {

      finish(
        `[PORT] ${host}:${port} => TIMEOUT/FILTERED`
      );
    });


    socket.once("error", (err) => {

      const code =
        err && err.code
          ? err.code
          : "ERROR";


      if (code === "ECONNREFUSED") {

        return finish(
          `[PORT] ${host}:${port} => REFUSED`
        );
      }


      if (code === "ETIMEDOUT") {

        return finish(
          `[PORT] ${host}:${port} => TIMEOUT/FILTERED`
        );
      }


      if (
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN"
      ) {

        return finish(
          `[PORT] ${host}:${port} => DNS_FAIL`
        );
      }


      if (
        code === "EHOSTUNREACH" ||
        code === "ENETUNREACH"
      ) {

        return finish(
          `[PORT] ${host}:${port} => UNREACHABLE`
        );
      }


      finish(
        `[PORT] ${host}:${port} => ${code}`
      );
    });


    socket.connect(port, host);
  });
}


// ============================================================
// WHOIS DOMAIN
// ============================================================

function findFirst(lines, regexList) {

  for (const line of lines) {

    for (const re of regexList) {

      const m = line.match(re);

      if (m && m[1]) {
        return m[1].trim();
      }
    }
  }

  return null;
}


function pickWhoisFields(whoisText) {

  const lines = whoisText.split(/\r?\n/);


  const registrar =
    findFirst(lines, [

      /^\s*Registrar:\s*(.+)$/i,
      /^\s*registrar name:\s*(.+)$/i,
      /^\s*Registrar\s*Name:\s*(.+)$/i,
      /^\s*Registered by:\s*(.+)$/i,

    ]) || "-";


  const created =
    findFirst(lines, [

      /^\s*Creation Date:\s*(.+)$/i,
      /^\s*Created On:\s*(.+)$/i,
      /^\s*Domain Registration Date:\s*(.+)$/i,
      /^\s*created:\s*(.+)$/i,
      /^\s*Registered On:\s*(.+)$/i,
      /^\s*Registration date:\s*(.+)$/i,
      /^\s*Registered:\s*(.+)$/i,

    ]) || "-";


  const expiry =
    findFirst(lines, [

      /^\s*Registry Expiry Date:\s*(.+)$/i,
      /^\s*Expiration Date:\s*(.+)$/i,
      /^\s*Registrar Registration Expiration Date:\s*(.+)$/i,
      /^\s*paid-till:\s*(.+)$/i,
      /^\s*Expiry Date:\s*(.+)$/i,
      /^\s*expire:\s*(.+)$/i,
      /^\s*Expires On:\s*(.+)$/i,
      /^\s*Expiration Time:\s*(.+)$/i,
      /^\s*Valid Until:\s*(.+)$/i,

    ]) || "-";


  const ns = [];


  for (const line of lines) {

    const m =
      line.match(
        /^\s*Name Server:\s*(\S+)/i
      ) ||

      line.match(
        /^\s*nserver:\s*(\S+)/i
      ) ||

      line.match(
        /^\s*Nameserver:\s*(\S+)/i
      ) ||

      line.match(
        /^\s*NS:\s*(\S+)/i
      );


    if (m) {

      const v = m[1]
        .trim()
        .replace(/\.$/, "");


      if (!ns.includes(v)) {
        ns.push(v);
      }
    }


    if (ns.length >= 10) {
      break;
    }
  }


  return {
    registrar,
    created,
    expiry,
    ns,
  };
}


async function cmdDwhois(target, domain) {

  if (!isDomain(domain)) {

    return say(
      target,
      "Pakai: .dwhois domain.com"
    );
  }


  try {

    const out = await runCmd(
      "whois",
      [domain],
      15000
    );


    const {
      registrar,
      created,
      expiry,
      ns,
    } = pickWhoisFields(out);


    const nsTxt =
      ns.length
        ? ns.join(", ")
        : "-";


    say(
      target,
      `[WHOIS] ${domain} | Registrar: ${registrar} | Created: ${created} | Expire: ${expiry} | NS: ${nsTxt}`
    );

  } catch (e) {

    say(
      target,
      `[WHOIS] gagal: ${e.message}`
    );
  }
}


// ============================================================
// FORMAT WAKTU
// ============================================================

function fmtLong(sec) {

  sec = Math.max(
    0,
    Math.floor(sec || 0)
  );


  const d = Math.floor(sec / 86400);

  sec %= 86400;


  const h = Math.floor(sec / 3600);

  sec %= 3600;


  const m = Math.floor(sec / 60);

  sec %= 60;


  const parts = [];


  if (d) {
    parts.push(`${d} days`);
  }


  if (h) {
    parts.push(`${h} hours`);
  }


  if (m) {
    parts.push(`${m} minutes`);
  }


  if (!parts.length) {
    parts.push(`${sec} seconds`);
  }


  return parts.join(" ");
}


function fmtDate(ts) {

  const d = new Date(ts * 1000);


  return d
    .toLocaleString(
      "en-GB",
      {
        timeZone: "Asia/Jakarta",
        hour12: false,
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }
    )
    .replace(",", "");
}


// ============================================================
// .I - IDLE
// ============================================================

function cmdWhoisIdle(target, nick) {

  if (!nick) {

    return say(
      target,
      "Pakai: .i nick"
    );
  }


  const wanted = nick.toLowerCase();


  let gotIdle = null;
  let gotSignon = null;


  const onRaw = (msg) => {

    const cmd =
      String(msg.command || "")
        .toLowerCase();


    if (
      cmd === "317" ||
      cmd === "rpl_whoisidle"
    ) {

      const p = msg.args || [];


      const targetNick =
        (p[1] || "").toLowerCase();


      if (targetNick !== wanted) {
        return;
      }


      const idleSec =
        parseInt(p[2], 10);


      const signon =
        parseInt(p[3], 10);


      if (Number.isFinite(idleSec)) {
        gotIdle = idleSec;
      }


      if (Number.isFinite(signon)) {
        gotSignon = signon;
      }


      return;
    }


    if (
      cmd === "318" ||
      cmd === "rpl_endofwhois"
    ) {

      const p = msg.args || [];


      const targetNick =
        (p[1] || "").toLowerCase();


      if (targetNick !== wanted) {
        return;
      }


      cleanup();


      const idleTxt =
        fmtLong(gotIdle || 0);


      if (!gotSignon) {

        return say(
          target,
          `${nick} : idle ${idleTxt} - signed on - WIB - Online: -`
        );
      }


      const signedTxt =
        fmtDate(gotSignon);


      const onlineSec =
        Math.max(
          0,
          Math.floor(Date.now() / 1000) - gotSignon
        );


      const onlineTxt =
        fmtLong(onlineSec);


      say(
        target,
        `${nick} : idle ${idleTxt} - signed on ${signedTxt} WIB - Online: ${onlineTxt}`
      );
    }
  };


  const cleanup = () => {

    client.removeListener(
      "raw",
      onRaw
    );

    clearTimeout(tmo);
  };


  client.addListener(
    "raw",
    onRaw
  );


  client.send(
    "WHOIS",
    nick,
    nick
  );


  const tmo = setTimeout(() => {

    cleanup();

    say(
      target,
      `${nick} : WHOIS timeout`
    );

  }, 6000);
}


// ============================================================
// .WHOIS
// ============================================================

function cmdWhoisWhere(target, nick) {

  if (!nick) {

    return say(
      target,
      "Pakai: .whois nick"
    );
  }


  const wanted =
    nick.toLowerCase();


  const st = {

    nick: nick,

    user: null,
    host: null,
    gecos: null,

    server: null,
    serverInfo: null,

    account: null,

    identified: false,
    ssl: false,

    idleSec: null,
    signon: null,

    channels: [],
  };


  const onRaw = (msg) => {

    const cmd =
      String(msg.command || "")
        .toLowerCase();


    const p =
      msg.args || [];


    const targetNick =
      (p[1] || "").toLowerCase();


    // 311
    if (
      cmd === "311" ||
      cmd === "rpl_whoisuser"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      st.user =
        p[2] || st.user;


      st.host =
        p[3] || st.host;


      st.gecos =
        String(
          p[p.length - 1] || ""
        )
          .replace(/^:/, "")
          .trim() ||
        st.gecos;


      return;
    }


    // 312
    if (
      cmd === "312" ||
      cmd === "rpl_whoisserver"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      st.server =
        p[2] || st.server;


      st.serverInfo =
        String(
          p[p.length - 1] || ""
        )
          .replace(/^:/, "")
          .trim() ||
        st.serverInfo;


      return;
    }


    // 319
    if (
      cmd === "319" ||
      cmd === "rpl_whoischannels"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      const rawList =
        String(
          p[p.length - 1] || ""
        )
          .replace(/^:/, "")
          .trim();


      if (!rawList) {
        return;
      }


      const add =
        rawList.split(/\s+/);


      for (const ch of add) {

        if (
          ch &&
          !st.channels.includes(ch)
        ) {

          st.channels.push(ch);
        }
      }


      return;
    }


    // 330
    if (
      cmd === "330" ||
      cmd === "rpl_whoisaccount"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      st.account =
        p[2] || st.account;


      st.identified = true;


      return;
    }


    // identified text
    if (targetNick === wanted) {

      const last =
        String(
          p[p.length - 1] || ""
        )
          .replace(/^:/, "")
          .toLowerCase();


      if (
        last.includes(
          "has identified"
        )
      ) {

        st.identified = true;
      }
    }


    // 320
    if (
      cmd === "320" ||
      cmd === "rpl_whoisidentified"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      st.identified = true;

      return;
    }


    // 671 SSL
    if (
      cmd === "671" ||
      cmd === "rpl_whoissecure"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      st.ssl = true;

      return;
    }


    // 317 idle
    if (
      cmd === "317" ||
      cmd === "rpl_whoisidle"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      const idleSec =
        parseInt(p[2], 10);


      const signon =
        parseInt(p[3], 10);


      if (Number.isFinite(idleSec)) {
        st.idleSec = idleSec;
      }


      if (Number.isFinite(signon)) {
        st.signon = signon;
      }


      return;
    }


    // 318 end
    if (
      cmd === "318" ||
      cmd === "rpl_endofwhois"
    ) {

      if (targetNick !== wanted) {
        return;
      }


      cleanup();


      const uh =
        (st.user && st.host)
          ? `${st.user}@${st.host}`
          : "-";


      const rn =
        st.gecos || "-";


      const srv =
        st.server
          ? `${st.server}${
              st.serverInfo
                ? " (" + st.serverInfo + ")"
                : ""
            }`
          : "-";


      const idTxt =
        st.identified
          ? `ID:${st.account || "yes"}`
          : "ID:no";


      const sslTxt =
        st.ssl
          ? "SSL:yes"
          : "SSL:no";


      say(
        target,
        `[W] ${nick}: ${uh} | ${rn}`
      );


      say(
        target,
        `[w] ${nick}: ${idTxt} | ${srv} | ${sslTxt}`
      );


      if (
        st.channels &&
        st.channels.length
      ) {

        sayChunked(
          target,
          `[W] ${nick} on: `,
          st.channels
        );

      } else {

        say(
          target,
          `[W] ${nick} on: -`
        );
      }
    }
  };


  const cleanup = () => {

    client.removeListener(
      "raw",
      onRaw
    );

    clearTimeout(tmo);
  };


  client.addListener(
    "raw",
    onRaw
  );


  client.send(
    "WHOIS",
    nick,
    nick
  );


  const tmo = setTimeout(() => {

    cleanup();

    say(
      target,
      `[W] ${nick}: WHOIS timeout`
    );

  }, 7000);
}


// ============================================================
// IRC FORMATTING
// ============================================================

function stripIrcFormatting(s) {

  return String(s || "")
    .replace(/\x02/g, "")
    .replace(/\x1F/g, "")
    .replace(/\x16/g, "")
    .replace(/\x0F/g, "")
    .replace(
      /\x03(\d{1,2}(,\d{1,2})?)?/g,
      ""
    );
}


// ============================================================
// NICKSERV
// OWNER ONLY
// ============================================================

function cmdNickServInfo(target, nick) {

  if (!nick) {

    return say(
      target,
      "Pakai: .ns nick"
    );
  }


  const myNick = () =>
    String(
      client.nick ||
      CONFIG.nick ||
      ""
    ).toLowerCase();


  let buffer = [];

  let idleTimer = null;


  const flush = () => {

    cleanup();


    if (!buffer.length) {
      return;
    }


    for (const line of buffer) {

      say(
        target,
        `[NS] ${line}`
      );
    }
  };


  const onNotice =
    (from, to, text) => {

      if (
        !from ||
        from.toLowerCase() !== "nickserv"
      ) {
        return;
      }


      if (
        !to ||
        to.toLowerCase() !== myNick()
      ) {
        return;
      }


      const clean =
        stripIrcFormatting(text)
          .trim();


      if (!clean) {
        return;
      }


      buffer.push(clean);


      clearTimeout(idleTimer);


      idleTimer = setTimeout(
        flush,
        1500
      );
    };


  const cleanup = () => {

    client.removeListener(
      "notice",
      onNotice
    );


    clearTimeout(idleTimer);
    clearTimeout(hardTimeout);
  };


  client.addListener(
    "notice",
    onNotice
  );


  client.say(
    "NickServ@services.dal.net",
    `INFO ${nick}`
  );


  const hardTimeout =
    setTimeout(() => {

      cleanup();

    }, 10000);
}


// ============================================================
// CHANSERV
// OWNER ONLY
// ============================================================

function cmdChanServInfo(target, channel) {

  if (!channel) {

    return say(
      target,
      "Pakai: .cs #channel"
    );
  }


  const myNick = () =>
    String(
      client.nick ||
      CONFIG.nick ||
      ""
    ).toLowerCase();


  let buffer = [];

  let idleTimer = null;


  const flush = () => {

    cleanup();


    if (!buffer.length) {
      return;
    }


    for (const line of buffer) {

      say(
        target,
        `[CS] ${line}`
      );
    }
  };


  const onNotice =
    (from, to, text) => {

      if (
        !from ||
        from.toLowerCase() !== "chanserv"
      ) {
        return;
      }


      if (
        !to ||
        to.toLowerCase() !== myNick()
      ) {
        return;
      }


      const clean =
        text.trim();


      if (!clean) {
        return;
      }


      buffer.push(clean);


      clearTimeout(idleTimer);


      idleTimer = setTimeout(
        flush,
        1500
      );
    };


  const cleanup = () => {

    client.removeListener(
      "notice",
      onNotice
    );


    clearTimeout(idleTimer);
    clearTimeout(hardTimeout);
  };


  client.addListener(
    "notice",
    onNotice
  );


  client.say(
    "ChanServ@services.dal.net",
    `INFO ${channel}`
  );


  const hardTimeout =
    setTimeout(() => {

      cleanup();

    }, 10000);
}


// ============================================================
// IP LOOKUP
// ============================================================

async function ipLookupOne(ip) {

  const fields = [
    "status",
    "message",
    "query",
    "country",
    "regionName",
    "city",
    "isp",
    "org",
    "as",
    "timezone",
  ].join(",");


  const url =
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${encodeURIComponent(fields)}`;


  const res =
    await fetch(
      url,
      {
        method: "GET",
      }
    );


  const data =
    await res.json();


  if (data.status !== "success") {

    return `[${ip}] gagal (${data.message || "unknown"})`;
  }


  const loc =
    [
      data.regionName,
      data.city,
    ]
      .filter(Boolean)
      .join(", ");


  const isp =
    data.isp ||
    data.org ||
    "-";


  return `[${data.query}] ${data.country || "-"} | ${loc || "-"} | ${isp} | ${data.as || "-"} | ${data.timezone || "-"}`;
}


function sleep(ms) {

  return new Promise(
    r => setTimeout(r, ms)
  );
}


// ============================================================
// .IP
// ============================================================

async function cmdIp(target, input) {

  if (!input) {

    return say(
      target,
      "Pakai: .ip ip_atau_domain_atau_nick"
    );
  }


  let query = input;


  if (looksLikeNick(input)) {

    try {

      const host =
        await getNickHost(input);


      query = host;

    } catch (e) {

      return say(
        target,
        `[IP] ${input}: gagal ambil host (${e.message})`
      );
    }
  }


  let ips = [];


  if (isIP(query)) {

    ips = [query];

  } else if (isDomain(query)) {

    ips =
      await resolveDomainToAllIPs(query);


    if (!ips.length) {

      return say(
        target,
        `[IP] ${query}: gagal resolve (A/AAAA kosong)`
      );
    }

  } else {

    try {

      const r =
        await dns.lookup(
          query,
          {
            all: true,
          }
        );


      ips =
        [
          ...new Set(
            r.map(
              x => x.address
            )
          ),
        ];


      if (!ips.length) {

        return say(
          target,
          `[IP] ${query}: gagal resolve`
        );
      }

    } catch (e) {

      return say(
        target,
        `[IP] ${query}: gagal resolve (${e.code || e.message})`
      );
    }
  }


  const delayMs = 1500;


  for (
    let i = 0;
    i < ips.length;
    i++
  ) {

    const ip = ips[i];


    try {

      const line =
        await ipLookupOne(ip);


      say(
        target,
        `IP ${i + 1}/${ips.length}: ${line}`
      );

    } catch (e) {

      say(
        target,
        `IP ${i + 1}/${ips.length}: [${ip}] error (${e.message})`
      );
    }


    await sleep(delayMs);
  }
}


// ============================================================
// CHANNEL MANAGEMENT
// OWNER ONLY
// ============================================================

function cmdJoin(target, channel) {

  if (!channel || !isChannel(channel)) {

    return say(
      target,
      "Pakai: .join #channel"
    );
  }


  client.join(
    channel,
    (err) => {

      if (err) {

        return say(
          target,
          `[JOIN] ${channel}: gagal (${err.message || err})`
        );
      }


      say(
        target,
        `[JOIN] ${channel}: OK`
      );
    }
  );
}


function cmdPart(target, channel) {

  if (!channel || !isChannel(channel)) {

    return say(
      target,
      "Pakai: .part #channel"
    );
  }


  client.part(
    channel,
    "Leaving channel",
    (err) => {

      if (err) {

        return say(
          target,
          `[PART] ${channel}: gagal (${err.message || err})`
        );
      }


      say(
        target,
        `[PART] ${channel}: OK`
      );
    }
  );
}


function cmdRejoin(target, channel) {

  if (!channel || !isChannel(channel)) {

    return say(
      target,
      "Pakai: .rejoin #channel"
    );
  }


  client.part(
    channel,
    "Rejoin"
  );


  setTimeout(() => {

    client.join(
      channel,
      (err) => {

        if (err) {

          return say(
            target,
            `[REJOIN] ${channel}: gagal (${err.message || err})`
          );
        }


        say(
          target,
          `[REJOIN] ${channel}: OK`
        );
      }
    );

  }, 1500);
}


function cmdChannels(target) {

  const channels =
    Object.keys(
      client.chans || {}
    );


  if (!channels.length) {

    return say(
      target,
      "[CHANNEL] Tidak sedang berada di channel."
    );
  }


  sayChunked(
    target,
    "[CHANNEL] ",
    channels
  );
}


// ============================================================
// COMMAND HANDLER
// ============================================================

function handleCommand(from, to, text) {

  const target =
    to.startsWith("#")
      ? to
      : from;


  if (!text.startsWith(".")) {
    return;
  }


  const parts =
    text
      .trim()
      .split(/\s+/);


  const cmd =
    parts[0].toLowerCase();


  const args =
    parts.slice(1);


  // ----------------------------------------------------------
  // PUBLIC COMMANDS
  // ----------------------------------------------------------

  if (cmd === ".dns") {
    return cmdDns(
      target,
      args[0]
    );
  }


  if (cmd === ".dwhois") {
    return cmdDwhois(
      target,
      args[0]
    );
  }


  if (cmd === ".i") {
    return cmdWhoisIdle(
      target,
      args[0]
    );
  }


  // .w DIHAPUS
  // Sekarang hanya .whois
  if (cmd === ".whois") {
    return cmdWhoisWhere(
      target,
      args[0]
    );
  }


  if (cmd === ".ip") {
    return cmdIp(
      target,
      args[0]
    );
  }


  if (cmd === ".port") {

    const hp =
      parseHostPort(args);


    if (!hp) {

      return say(
        target,
        "Pakai: .port host port  (atau .port host:port)"
      );
    }


    return cmdPort(
      target,
      hp.host,
      hp.port
    );
  }


  // ----------------------------------------------------------
  // CHANNEL LIST - PUBLIC
  // ----------------------------------------------------------

  if (cmd === ".channels") {

    return cmdChannels(target);
  }


  // ----------------------------------------------------------
  // OWNER ONLY
  // ----------------------------------------------------------

  if (
    cmd === ".join" ||
    cmd === ".part" ||
    cmd === ".rejoin" ||
    cmd === ".ns" ||
    cmd === ".cs" ||
    cmd === ".nsraw"
  ) {

    if (!isOwner(from)) {

      return say(
        target,
        "Maaf, command ini hanya untuk owner."
      );
    }
  }


  // ----------------------------------------------------------
  // JOIN
  // ----------------------------------------------------------

  if (cmd === ".join") {

    return cmdJoin(
      target,
      args[0]
    );
  }


  // ----------------------------------------------------------
  // PART
  // ----------------------------------------------------------

  if (cmd === ".part") {

    return cmdPart(
      target,
      args[0]
    );
  }


  // ----------------------------------------------------------
  // REJOIN
  // ----------------------------------------------------------

  if (cmd === ".rejoin") {

    return cmdRejoin(
      target,
      args[0]
    );
  }


  // ----------------------------------------------------------
  // NICKSERV INFO
  // ----------------------------------------------------------

  if (cmd === ".ns") {

    return cmdNickServInfo(
      target,
      args[0]
    );
  }


  // ----------------------------------------------------------
  // CHANSERV INFO
  // ----------------------------------------------------------

  if (cmd === ".cs") {

    return cmdChanServInfo(
      target,
      args[0]
    );
  }


  // ----------------------------------------------------------
  // NICKSERV RAW
  // ----------------------------------------------------------

  if (cmd === ".nsraw") {

    if (!args.length) {

      return say(
        target,
        "Pakai: .nsraw command"
      );
    }


    client.say(
      "NickServ@services.dal.net",
      args.join(" ")
    );


    return say(
      target,
      "[NS] sent raw to NickServ"
    );
  }


  // ----------------------------------------------------------
  // HELP
  // ----------------------------------------------------------

  if (cmd === ".help") {

    return say(
      target,
      "Cmd: .dns | .port | .dwhois | .i | .whois | .ip | .channels | .help"
    );
  }
}


// ============================================================
// IRC MESSAGE
// ============================================================

client.addListener(
  "message",
  (from, to, text) => {

    try {

      handleCommand(
        from,
        to,
        text
      );

    } catch (e) {

      console.log(
        "Command error:",
        e
      );
    }
  }
);


// ============================================================
// IRC ERROR
// ============================================================

client.addListener(
  "error",
  (message) => {

    console.log(
      "IRC error:",
      message
    );
  }
);


// ============================================================
// START
// ============================================================

console.log(
  "Bot starting:",
  CONFIG.nick,
  "->",
  CONFIG.server,
  CONFIG.channels.join(", ")
);
```
