import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = __dirname;

// ─── 从 settings.json 的 "pi-email" 字段读取配置 ───
interface AccountConfig {
  name: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  user: string;
  pass: string;
  auth_type?: "basic" | "oauth2";
  login_user?: string;
  oauth2?: {
    provider: string;
    client_id: string;
    client_secret?: string;
    authority: string;
    scopes: string[];
    redirect_uri: string;
  };
}

interface EmailConfig {
  accounts: AccountConfig[];
}

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PI_AGENT = join(HOME, ".pi", "agent");

function loadConfig(): EmailConfig {
  const settingsPath = join(PI_AGENT, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return settings["pi-email"] || { accounts: [] };
  } catch { return { accounts: [] }; }
}

const CONFIG = loadConfig();

// ─── OAuth2 token 管理 ───
// 内存缓存（用于 headless 登录的账号，无 refresh_token）
const tokenCache: Record<string, { accessToken: string; expiresAt: number }> = {};
// MSAL 实例缓存（用于 Microsoft 账号）
const msalInstances: Record<string, any> = {};
// Google token 持久化缓存
const googleTokenCaches: Record<string, { refreshToken: string; accessToken: string; expiresAt: number } | null> = {};

function getMsalCachePath(user: string): string {
  const safe = user.replace(/[^a-zA-Z0-9]/g, "_");
  return join(PI_AGENT, `oauth-cache-${safe}.json`);
}

function getMsalInstance(account: AccountConfig): any {
  const key = account.user;
  if (!msalInstances[key]) {
    const { PublicClientApplication } = require("@azure/msal-node");
    const oauth = account.oauth2!;
    const pca = new PublicClientApplication({
      auth: { clientId: oauth.client_id, authority: oauth.authority },
    });
    // 加载持久化缓存
    const cachePath = getMsalCachePath(account.user);
    if (existsSync(cachePath)) {
      try { pca.getTokenCache().deserialize(readFileSync(cachePath, "utf-8")); } catch {}
    }
    msalInstances[key] = pca;
  }
  return msalInstances[key];
}

function saveMsalCache(account: AccountConfig): void {
  const pca = msalInstances[account.user];
  if (!pca) return;
  try {
    const cachePath = getMsalCachePath(account.user);
    const dir = join(cachePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, pca.getTokenCache().serialize());
  } catch {}
}

function getGoogleCachePath(user: string): string {
  const safe = user.replace(/[^a-zA-Z0-9]/g, "_");
  return join(PI_AGENT, `google-token-cache-${safe}.json`);
}

function loadGoogleCache(user: string): { refreshToken: string; accessToken: string; expiresAt: number } | null {
  const key = user;
  if (googleTokenCaches[key]) return googleTokenCaches[key];
  const cachePath = getGoogleCachePath(user);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf-8"));
      // 兼容驼峰和下划线两种格式
      const rt = data.refreshToken || data.refresh_token;
      if (rt) {
        const cached = {
          refreshToken: rt,
          accessToken: data.accessToken || data.access_token || "",
          expiresAt: data.expiresAt || Date.now(),
        };
        googleTokenCaches[key] = cached;
        return cached;
      }
    } catch {}
  }
  return null;
}

function saveGoogleCache(user: string, data: { refreshToken: string; accessToken: string; expiresAt: number }): void {
  const key = user;
  googleTokenCaches[key] = data;
  try {
    const cachePath = getGoogleCachePath(user);
    writeFileSync(cachePath, JSON.stringify(data));
  } catch {}
}

async function refreshGoogleToken(account: AccountConfig): Promise<string | null> {
  const cached = loadGoogleCache(account.user);
  if (!cached?.refreshToken) return null;
  const oauth = account.oauth2!;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauth.client_id,
        client_secret: oauth.client_secret || "",
        refresh_token: cached.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const data = await res.json() as any;
    if (data.access_token) {
      const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      saveGoogleCache(account.user, { refreshToken: cached.refreshToken, accessToken: data.access_token, expiresAt });
      return data.access_token;
    }
  } catch {}
  return null;
}

async function getAccessToken(account: AccountConfig, onUpdate?: any): Promise<string> {
  const key = account.user;
  const oauth = account.oauth2;
  if (!oauth) {
    // basic auth: 不需要 access token
    return "";
  }

  // 1. Google: 用 refresh_token 刷新
  if (oauth.provider === "google") {
    // 先检查内存缓存
    const cached = tokenCache[key];
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached.accessToken;
    }
    // 尝试用 refresh_token 刷新
    const token = await refreshGoogleToken(account);
    onUpdate?.({ content: [{ type: "text", text: `📧 Gmail token refresh: ${token ? "OK" : "FAILED"}` }] });
    if (token) {
      tokenCache[key] = { accessToken: token, expiresAt: (loadGoogleCache(account.user))!.expiresAt };
      return token;
    }
    // 需要 interactive 登录
    onUpdate?.({ content: [{ type: "text", text: `🔐 Gmail 需要授权，请在弹出的浏览器中登录 ${account.user}` }] });
    const result = await googleInteractiveLogin(account, onUpdate);
    tokenCache[key] = result;
    return result.accessToken;
  }

  // 2. Microsoft: 先试 MSAL 静默刷新
  const pca = getMsalInstance(account);
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const r = await pca.acquireTokenSilent({ account: accounts[0], scopes: oauth.scopes });
      if (r?.accessToken) {
        saveMsalCache(account);
        tokenCache[key] = {
          accessToken: r.accessToken,
          expiresAt: r.expiresOn ? new Date(r.expiresOn).getTime() : Date.now() + 55 * 60 * 1000,
        };
        return r.accessToken;
      }
    } catch {
      // 静默刷新失败，继续尝试其他方式
    }
  }

  // 3. 内存缓存检查
  const cached = tokenCache[key];
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.accessToken;
  }

  // 4. 需要 headless 登录（学校邮箱等无 refresh_token 的账号）
  if (account.login_user || account.pass) {
    const token = await headlessLogin(account);
    tokenCache[key] = token;
    return token.accessToken;
  }

  // 5. 需要 interactive 登录（个人 Outlook 等，首次弹出浏览器）
  onUpdate?.({ content: [{ type: "text", text: `🔐 Outlook 需要授权，请在弹出的浏览器中登录 ${account.user}` }] });
  const token = await interactiveLogin(account, onUpdate);
  tokenCache[key] = token;
  return token.accessToken;
}

// headless 自动登录（学校邮箱：Keycloak SAML 联合认证）
async function headlessLogin(account: AccountConfig): Promise<{ accessToken: string; expiresAt: number }> {
  const puppeteer = require("puppeteer-core");
  const path = require("node:path");
  const http = require("node:http");

  const oauth = account.oauth2!;
  const pca = getMsalInstance(account);

  const authUrl = await pca.getAuthCodeUrl({
    scopes: oauth.scopes,
    redirectUri: oauth.redirect_uri,
  });

  // 本地服务器接收回调
  let resolveCode: (code: string | null) => void;
  const codePromise = new Promise<string | null>((r) => (resolveCode = r));
  const server = http.createServer((req: any, res: any) => {
    const url = new URL(req.url, oauth.redirect_uri);
    const code = url.searchParams.get("code");
    if (code) {
      res.end("<h2>OK</h2>");
      resolveCode(code);
      setTimeout(() => server.close(), 500);
    } else {
      const error = url.searchParams.get("error");
      if (error) { res.end("Error"); resolveCode(null); setTimeout(() => server.close(), 500); }
      else { res.end("..."); }
    }
  });
  await new Promise<void>((r) => server.listen(8401, r));

  // headless Chrome 自动登录
  const chromePath = path.join("C:", "Program Files", "Google", "Chrome", "Application", "chrome.exe");
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {} };
  });

  try {
    // Step 1: Microsoft 登录页 - 输入邮箱
    await page.goto(authUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("#i0116", { timeout: 10000 });
    await page.type("#i0116", account.user);
    await page.click("#idSIButton9");

    // Step 2: 等待跳转到 Keycloak
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const url = page.url();
      if (url.includes("knossos") || url.includes("login-actions")) break;
    }

    // Step 3: 填写 Keycloak 用户名密码
    await page.waitForSelector("#username", { timeout: 10000 });
    await page.waitForSelector("#password", { timeout: 10000 });
    await page.evaluate(() => {
      const u = document.getElementById("username") as HTMLInputElement;
      const p = document.getElementById("password") as HTMLInputElement;
      if (u) u.value = "";
      if (p) p.value = "";
    });
    await page.type("#username", account.login_user || account.user);
    await page.type("#password", account.pass);
    await page.click("#kc-login");

    // Step 4: 等待回调（处理可能的中间页面）
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const url = page.url();
      if (url.includes("localhost:8401")) break;
      // "保持登录" 页面
      try {
        const btn = await page.$("#idSIButton9");
        if (btn) {
          const text = await page.evaluate((el: any) => el.textContent, btn);
          if (text && (text.includes("Yes") || text.includes("是"))) await btn.click();
        }
      } catch {}
    }
  } finally {
    await browser.close();
  }

  // Step 5: 用 code 换 token
  const code = await codePromise;
  if (!code) throw new Error("OAuth2 登录失败：未收到 authorization code");

  const response = await pca.acquireTokenByCode({
    code,
    scopes: oauth.scopes,
    redirectUri: oauth.redirect_uri,
  });

  if (!response.accessToken) throw new Error("OAuth2 登录失败：未收到 access_token");

  const expiresAt = response.expiresOn
    ? new Date(response.expiresOn).getTime()
    : Date.now() + 55 * 60 * 1000;

  // 保存 MSAL 缓存（如果拿到 refresh_token）
  saveMsalCache(account);

  return { accessToken: response.accessToken, expiresAt };
}

// interactive 登录（个人 Outlook 等：弹出浏览器，用户手动授权）
async function interactiveLogin(account: AccountConfig, _onUpdate?: any): Promise<{ accessToken: string; expiresAt: number }> {
  const http = require("node:http");
  const fs = require("node:fs");
  const os = require("node:os");

  const oauth = account.oauth2!;
  const pca = getMsalInstance(account);

  const authUrl = await pca.getAuthCodeUrl({
    scopes: oauth.scopes,
    redirectUri: oauth.redirect_uri,
  });

  // 用 HTML 重定向文件打开浏览器（避免 cmd start 截断长 URL）
  const htmlPath = join(os.tmpdir(), "pi-email-auth.html");
  fs.writeFileSync(htmlPath, '<meta http-equiv="refresh" content="0;url=' + authUrl.replace(/&/g, "&amp;") + '">');
  require("child_process").spawn("cmd", ["/c", "start", "", htmlPath], { detached: true });

  // 等待回调
  const code = await new Promise<string | null>((resolve) => {
    const server = http.createServer((req: any, res: any) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const url = new URL(req.url, oauth.redirect_uri);
      const c = url.searchParams.get("code");
      if (c) { res.end("OK"); resolve(c); setTimeout(() => server.close(), 1000); }
      else { res.end("..."); }
    });
    server.listen(new URL(oauth.redirect_uri).port || 8401);
    // 120 秒超时
    setTimeout(() => { resolve(null); server.close(); }, 120_000);
  });

  if (!code) throw new Error("OAuth2 授权超时（120秒），请重试");

  const response = await pca.acquireTokenByCode({
    code,
    scopes: oauth.scopes,
    redirectUri: oauth.redirect_uri,
  });

  if (!response.accessToken) throw new Error("OAuth2 登录失败：未收到 access_token");

  saveMsalCache(account);

  const expiresAt = response.expiresOn
    ? new Date(response.expiresOn).getTime()
    : Date.now() + 55 * 60 * 1000;

  return { accessToken: response.accessToken, expiresAt };
}

// Google 交互式登录（首次弹出浏览器，拿 refresh_token 后自动刷新）
async function googleInteractiveLogin(account: AccountConfig, _onUpdate?: any): Promise<{ accessToken: string; expiresAt: number }> {
  const http = require("node:http");
  const os = require("node:os");
  const oauth = account.oauth2!;

  const params = new URLSearchParams({
    client_id: oauth.client_id,
    redirect_uri: oauth.redirect_uri,
    response_type: "code",
    scope: oauth.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  const authUrl = `${oauth.authority}/o/oauth2/v2/auth?${params.toString()}`;

  // 用 HTML 重定向文件打开浏览器
  const htmlPath = join(os.tmpdir(), "pi-email-google-auth.html");
  writeFileSync(htmlPath, '<meta http-equiv="refresh" content="0;url=' + authUrl.replace(/&/g, "&amp;") + '">');
  require("child_process").exec(`cmd /c start "" "${htmlPath}"`);

  const code = await new Promise<string | null>((resolve) => {
    const server = http.createServer((req: any, res: any) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const url = new URL(req.url, oauth.redirect_uri);
      const c = url.searchParams.get("code");
      if (c) { res.end("OK"); resolve(c); setTimeout(() => server.close(), 1000); }
      else { res.end("..."); }
    });
    server.listen(new URL(oauth.redirect_uri).port || 8401);
    setTimeout(() => { resolve(null); server.close(); }, 120_000);
  });

  if (!code) throw new Error("Google 授权超时（120秒），请重试");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: oauth.client_id,
      client_secret: oauth.client_secret || "",
      redirect_uri: oauth.redirect_uri,
      grant_type: "authorization_code",
    }),
  });
  const tokenData = await tokenRes.json() as any;
  if (!tokenData.access_token) throw new Error("Google OAuth2 登录失败：未收到 access_token");

  const expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;
  saveGoogleCache(account.user, {
    refreshToken: tokenData.refresh_token,
    accessToken: tokenData.access_token,
    expiresAt,
  });

  return { accessToken: tokenData.access_token, expiresAt };
}

function getAccount(name?: string): AccountConfig {
  if (CONFIG.accounts.length === 0) throw new Error("未配置邮箱账号，请在 settings.json 的 pi-email.accounts 中添加");
  if (!name) return CONFIG.accounts[0];
  const acc = CONFIG.accounts.find(a => a.name === name || a.user === name);
  if (!acc) throw new Error(`未找到邮箱账号 "${name}"，已配置: ${CONFIG.accounts.map(a => a.name).join(", ")}`);
  return acc;
}

// 查找垃圾邮件文件夹名（不同邮箱名称不同）
async function findJunkFolder(client: any): Promise<string | null> {
  const folders = await client.list();
  // 按 specialUse 优先，然后按常见名称匹配
  for (const f of folders) {
    if (f.specialUse?.includes("\\Junk")) return f.path;
  }
  const junkNames = ["垃圾邮件", "Spam", "Junk", "Junk E-mail", "垃圾箱", "[Gmail]/垃圾邮件", "[Gmail]/Spam"];
  for (const f of folders) {
    if (junkNames.includes(f.path)) return f.path;
  }
  return null;
}

// ─── IMAP helper ───
async function withImap<T>(account: AccountConfig, onUpdate: any, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const isOAuth2 = account.auth_type === "oauth2";
  let auth: any;
  if (isOAuth2) {
    const accessToken = await getAccessToken(account, onUpdate);
    auth = { user: account.user, accessToken };
  } else {
    auth = { user: account.user, pass: account.pass };
  }
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: true,
    auth,
    logger: false as any,
  });
  try {
    await client.connect();
    return await fn(client);
  } catch (e: any) {
    onUpdate?.({ content: [{ type: "text", text: `📧 IMAP error for ${account.name}: ${e.message}` }] });
    throw e;
  } finally {
    await client.logout().catch(() => {});
  }
}

// ─── Format helpers ───
function decodeHeader(raw: string): string {
  if (!raw) return "";
  // Simple decode for common patterns
  try {
    const parts: string[] = [];
    const re = /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi;
    let match;
    let lastIdx = 0;
    while ((match = re.exec(raw)) !== null) {
      parts.push(raw.slice(lastIdx, match.index));
      const charset = match[1];
      const encoding = match[2].toUpperCase();
      const data = match[3];
      if (encoding === "B") {
        parts.push(Buffer.from(data, "base64").toString(charset as BufferEncoding || "utf-8"));
      } else {
        parts.push(decodeURIComponent(data.replace(/_/g, " ")));
      }
      lastIdx = match.index + match[0].length;
    }
    parts.push(raw.slice(lastIdx));
    return parts.join("").trim();
  } catch {
    return raw;
  }
}

function formatAddr(addr: any): string {
  if (!addr) return "?";
  if (typeof addr === "string") return decodeHeader(addr);
  const name = addr.name ? decodeHeader(addr.name) : "";
  const email = addr.address || addr.email || "";
  return name ? `${name} <${email}>` : email;
}

function formatAddrs(addrs: any[]): string {
  if (!Array.isArray(addrs)) return formatAddr(addrs);
  return addrs.map(formatAddr).join(", ");
}

function fmtDate(d: Date): string {
  const today = new Date();
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function textPreview(text: string, max = 80): string {
  if (!text) return "";
  const clean = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

// ─── Extension entry ───

export default function (pi: ExtensionAPI) {

  pi.registerTool({
    name: "email_list",
    label: "Email List",
    description:
      "List emails from inbox or other folders via IMAP. Supports filtering by unread, from, subject, date range, and search keywords. " +
      "Returns sender, subject, date, and preview for each email.",
    promptSnippet: "邮件列表: 查看收件箱、搜索邮件",
    promptGuidelines: [
      "Use email_list when user asks to check inbox, find emails, search by sender/subject/keyword.",
      "folder defaults to INBOX. Common folders: INBOX, Sent, Drafts, Junk, Trash.",
      "search uses IMAP SEARCH (SUBJECT, FROM, BODY, SINCE, BEFORE, UNSEEN etc).",
      "Use email_read to read full content of a specific email.",
    ],
    parameters: Type.Object({
      account: Type.Optional(Type.String({ description: "Account name or email (default: first account)" })),
      folder: Type.Optional(Type.String({ description: "Folder name (default: INBOX)", default: "INBOX" })),
      limit: Type.Optional(Type.Number({ description: "Max emails to return (default 20)", default: 20 })),
      offset: Type.Optional(Type.Number({ description: "Skip first N emails for pagination (default 0)", default: 0 })),
      unread: Type.Optional(Type.Boolean({ description: "Only show unread emails" })),
      from: Type.Optional(Type.String({ description: "Filter by sender" })),
      subject: Type.Optional(Type.String({ description: "Filter by subject" })),
      body: Type.Optional(Type.String({ description: "Search email body text" })),
      since: Type.Optional(Type.String({ description: "Since date (e.g. '1-Jun-2026')" })),
      before: Type.Optional(Type.String({ description: "Before date (e.g. '7-Jun-2026')" })),
    }),
    async execute(_id: string, params: any, _sig: any, onUpdate: any, _ctx: any) {
      const { account: accName, folder = "INBOX", limit = 20, offset = 0, unread, from, subject, body, since, before } = params;
      const hasFilter = unread || from || subject || body || since || before;
      onUpdate?.({ content: [{ type: "text", text: `📋 email_list folder=${folder} limit=${limit}${hasFilter ? " (filtered)" : ""}` }] });

      try {
        const acc = getAccount(accName);
        const result = await withImap(acc, onUpdate, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const status = await client.status(folder, { messages: true, unseen: true });
            const total = status.messages || 0;
            const unseen = status.unseen || 0;

            if (hasFilter) {
              const emails: any[] = [];

              // unread 筛选用 IMAP SEARCH UNSEEN，服务器端搜索更准确
              if (unread && !from && !subject && !body && !since && !before) {
                // search 返回的是 UID，不是 seq
                const uids = [...await client.search({ unseen: true })];
                if (uids.length > 0) {
                  // 限制最多 fetch 200 封
                  const fetchUids = uids.length > 200 ? uids.slice(-200) : uids;
                  const range = fetchUids.join(",");
                  for await (const msg of client.fetch(range, { source: true, flags: true }, { uid: true })) {
                    const parsed = await simpleParser(msg.source as Buffer);
                    emails.push({
                      uid: msg.uid, seq: msg.seq,
                      from: formatAddrs(parsed.from?.value || []),
                      to: formatAddrs(parsed.to?.value || []),
                      subject: parsed.subject || "",
                      date: parsed.date ? new Date(parsed.date).toLocaleString("zh-CN") : "",
                      dateObj: parsed.date || new Date(0),
                      isRead: false,
                      preview: textPreview(parsed.text || "", 80),
                      hasAttachment: (parsed.attachments || []).length > 0,
                    });
                  }
                  // 按日期倒序，取 limit
                  emails.sort((a: any, b: any) => (b.dateObj?.getTime?.() || 0) - (a.dateObj?.getTime?.() || 0));
                  emails.splice(limit);
                }
                return { total, unseen, emails };
              }

              // 其他筛选条件：fetch recent batch + filter client-side
              const batchSize = Math.min(limit * 5, 500);
              const start = Math.max(1, total - batchSize + 1);
              for await (const msg of client.fetch(start + ":" + total, { source: true, flags: true }, { uid: false })) {
                const parsed = await simpleParser(msg.source as Buffer);
                const eFrom = (parsed.from?.value || []).map((a: any) => (a.name || "") + " " + (a.address || "")).join(" ").toLowerCase();
                const eSubject = (parsed.subject || "").toLowerCase();
                const eText = (parsed.text || "").slice(0, 500).toLowerCase();
                const eDate = parsed.date || new Date(0);
                if (from && !eFrom.includes(from.toLowerCase())) continue;
                if (subject && !eSubject.includes(subject.toLowerCase())) continue;
                if (body && !eText.includes(body.toLowerCase())) continue;
                if (since && eDate < new Date(since)) continue;
                if (before && eDate >= new Date(before)) continue;
                const isRead = !msg.flags?.has("\\\Seen");
                if (unread && isRead) continue;
                emails.push({
                  uid: msg.uid, seq: msg.seq,
                  from: formatAddrs(parsed.from?.value || []),
                  to: formatAddrs(parsed.to?.value || []),
                  subject: parsed.subject || "",
                  date: parsed.date ? new Date(parsed.date).toLocaleString("zh-CN") : "",
                  isRead,
                  preview: textPreview(parsed.text || "", 80),
                  hasAttachment: (parsed.attachments || []).length > 0,
                });
                if (emails.length >= limit) break;
              }
              return { total, unseen, emails: emails.reverse() };
            } else {
              // 无筛选：直接取最新的
              const end = total - offset;
              const start = Math.max(1, end - limit + 1);
              const emails: any[] = [];
              for await (const msg of client.fetch(start + ":" + end, { source: true, flags: true }, { uid: false })) {
                const parsed = await simpleParser(msg.source as Buffer);
                const isRead = !msg.flags?.has("\\\Seen");
                emails.push({
                  uid: msg.uid, seq: msg.seq,
                  from: formatAddrs(parsed.from?.value || []),
                  to: formatAddrs(parsed.to?.value || []),
                  subject: parsed.subject || "",
                  date: parsed.date ? new Date(parsed.date).toLocaleString("zh-CN") : "",
                  isRead,
                  preview: textPreview(parsed.text || "", 80),
                  hasAttachment: (parsed.attachments || []).length > 0,
                });
              }
              return { total, unseen, emails: emails.reverse() };
            }
          } finally {
            lock.release();
          }
        });

        if (result.emails.length === 0) {
          return { content: [{ type: "text", text: `${folder} 中没有匹配的邮件 (共${result.total}封)` }] };
        }

        const lines = result.emails.map(e =>
          `${e.isRead ? " " : "🔵"} [${e.seq}] ${fmtDate(new Date(e.date))} ${e.from}\n  └ ${e.subject}${e.preview ? "\n  " + e.preview : ""}`
        ).join("\n");
        const unseenInfo = result.unseen ? `，${result.unseen}封未读` : "";
        const text = `${folder} (${result.total}封${unseenInfo}，显示最新${result.emails.length}封)\n${lines}`;
        return { content: [{ type: "text", text }], details: { summary: `${folder}: ${result.total}封${unseenInfo}，显示${result.emails.length}封` } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);
      if (result.isError) return new Text(theme.fg("error", result.content?.[0]?.text || "Error"), 0, 0);
      const summary = result.details?.summary || "Done";
      return new Text(theme.fg("success", `✓ ${summary}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "email_read",
    label: "Email Read",
    description:
      "Read full email content by UID. Returns subject, from, to, date, body text, and attachment list. " +
      "Can download attachments to local files.",
    promptSnippet: "阅读邮件: 查看邮件完整内容",
    promptGuidelines: [
      "Use email_read after email_list to read a specific email's full content.",
      "UID comes from email_list results.",
    ],
    parameters: Type.Object({
      uid: Type.Number({ description: "Email sequence number from email_list" }),
      folder: Type.Optional(Type.String({ description: "Folder (default: INBOX)", default: "INBOX" })),
      account: Type.Optional(Type.String({ description: "Account name or email" })),
      markRead: Type.Optional(Type.Boolean({ description: "Mark as read after fetching (default: true)", default: true })),
    }),
    async execute(_id: string, params: any, _sig: any, onUpdate: any, _ctx: any) {
      const { uid, folder = "INBOX", account: accName, markRead = true } = params;
      onUpdate?.({ content: [{ type: "text", text: `📭 email_read uid=${uid} folder=${folder}` }] });

      try {
        const acc = getAccount(accName);
        const result = await withImap(acc, onUpdate, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const msg = await client.fetchOne(uid, {
              source: true,
              flags: true,
            }, { uid: false });

            const parsed = await simpleParser(msg.source as Buffer);

            // Extract attachments info
            const attachments = (parsed.attachments || []).map((att: any) => ({
              filename: att.filename || "unnamed",
              size: att.size,
              contentType: att.contentType,
            }));

            return {
              from: formatAddrs(parsed.from?.value || []),
              to: formatAddrs(parsed.to?.value || []),
              cc: formatAddrs(parsed.cc?.value || []),
              subject: parsed.subject || "",
              date: parsed.date ? new Date(parsed.date).toLocaleString("zh-CN") : "",
              text: parsed.text || parsed.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "",
              html: parsed.html || "",
              attachments,
              isRead: !msg.flags?.has("\\\Seen"),
            };
          } finally {
            lock.release();
          }
        });

        let text = `📧 ${result.subject}\n`;
        text += `发件人: ${result.from}\n`;
        text += `收件人: ${result.to}\n`;
        if (result.cc) text += `抄送: ${result.cc}\n`;
        text += `时间: ${result.date}\n`;
        if (result.attachments.length > 0) {
          text += `附件: ${result.attachments.map((a: any) => `${a.filename}(${(a.size / 1024).toFixed(0)}KB)`).join(", ")}\n`;
        }
        text += `\n${result.text}`;

        return { content: [{ type: "text", text }], details: { summary: `读取邮件 [${uid}]: ${result.subject || "(无标题)"}` } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);
      if (result.isError) return new Text(theme.fg("error", result.content?.[0]?.text || "Error"), 0, 0);
      const summary = result.details?.summary || "Done";
      return new Text(theme.fg("success", `✓ ${summary}`), 0, 0);
    },
  });



  pi.registerTool({
    name: "email_mark",
    label: "Email Mark",
    description:
      "Mark emails as read/unread, junk/not-junk, or flagged. " +
      "Marking as junk moves email to Junk folder, marking as not-junk moves back to INBOX. " +
      "Requires sequence number from email_list.",
    promptSnippet: "邮件标记: 标记已读/未读/垃圾/非垃圾/星标",
    parameters: Type.Object({
      seq: Type.Number({ description: "Email sequence number from email_list" }),
      mark: Type.Union([
        Type.Literal("read"),
        Type.Literal("unread"),
        Type.Literal("junk"),
        Type.Literal("not_junk"),
        Type.Literal("flag"),
        Type.Literal("unflag"),
      ], { description: "Action: read, unread, junk, not_junk, flag, unflag" }),
      folder: Type.Optional(Type.String({ description: "Folder (default INBOX)" })),
      account: Type.Optional(Type.String({ description: "Account name or email" })),
    }),
    async execute(_id: string, params: any, _sig: any, onUpdate: any, _ctx: any) {
      const { seq, mark, folder = "INBOX", account: accName } = params;
      onUpdate?.({ content: [{ type: "text", text: `🏷 email_mark seq=${seq} mark=${mark}` }] });

      try {
        const acc = getAccount(accName);
        const result = await withImap(acc, onUpdate, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            switch (mark) {
              case "read":
                await client.messageFlagsAdd(seq, ["\\\Seen"], { uid: false });
                return { action: "标记已读", seq };

              case "unread":
                await client.messageFlagsRemove(seq, ["\\\Seen"], { uid: false });
                return { action: "标记未读", seq };

              case "flag":
                await client.messageFlagsAdd(seq, ["\\Flagged"], { uid: false });
                return { action: "加星标", seq };

              case "unflag":
                await client.messageFlagsRemove(seq, ["\\Flagged"], { uid: false });
                return { action: "取消星标", seq };

              case "junk": {
                // 设置 $Junk flag，移除 $NotJunk
                await client.messageFlagsAdd(seq, ["$Junk"], { uid: false });
                await client.messageFlagsRemove(seq, ["$NotJunk"], { uid: false });
                // 移动到垃圾文件夹
                const junkFolder = await findJunkFolder(client);
                if (junkFolder && folder !== junkFolder) {
                  await client.messageMoveTo(seq, junkFolder, { uid: false });
                  return { action: "标记垃圾并移动", seq, movedTo: junkFolder };
                }
                return { action: "标记垃圾", seq, note: "未找到垃圾文件夹，仅设置标记" };
              }

              case "not_junk": {
                // 设置 $NotJunk flag，移除 $Junk
                await client.messageFlagsAdd(seq, ["$NotJunk"], { uid: false });
                await client.messageFlagsRemove(seq, ["$Junk"], { uid: false });
                // 如果在垃圾文件夹，移回收件箱
                const junkFolder = await findJunkFolder(client);
                if (junkFolder && folder === junkFolder) {
                  await client.messageMoveTo(seq, "INBOX", { uid: false });
                  return { action: "取消垃圾并移回收件箱", seq, movedTo: "INBOX" };
                }
                return { action: "取消垃圾标记", seq };
              }

              default:
                return { action: "未知操作", seq };
            }
          } finally {
            lock.release();
          }
        });

        const summary = `${result.action} [${seq}]` + (result.movedTo ? ` → ${result.movedTo}` : "");
        return { content: [{ type: "text", text: `✓ ${summary}` }], details: { summary } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);
      if (result.isError) return new Text(theme.fg("error", result.content?.[0]?.text || "Error"), 0, 0);
      const summary = result.details?.summary || "Done";
      return new Text(theme.fg("success", `✓ ${summary}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "email_folders",
    label: "Email Folders",
    description: "List all email folders/labels for an account.",
    promptSnippet: "邮件文件夹: 查看所有文件夹",
    parameters: Type.Object({
      account: Type.Optional(Type.String({ description: "Account name or email" })),
    }),
    async execute(_id: string, params: any, _sig: any, _onUpdate: any, _ctx: any) {
      const { account: accName } = params;
      try {
        const acc = getAccount(accName);
        const folders = await withImap(acc, onUpdate, async (client) => {
          const list = await client.list();
          return list.map((f: any) => {
            const special = f.specialUse ? ` [${f.specialUse}]` : '';
            return `${f.path}${special}`;
          });
        });

        return { content: [{ type: "text", text: `文件夹 (${folders.length}个):\n${folders.join("\n")}` }], details: { summary: `${folders.length}个文件夹` } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);
      if (result.isError) return new Text(theme.fg("error", result.content?.[0]?.text || "Error"), 0, 0);
      const summary = result.details?.summary || "Done";
      return new Text(theme.fg("success", `✓ ${summary}`), 0, 0);
    },
  });

  // ── Inject skill path ───
  pi.on("resources_discover", async () => {
    return { skillPaths: [SKILL_DIR] };
  });
}
