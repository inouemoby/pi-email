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

// ─── OAuth2 token 缓存 ───
const tokenCache: Record<string, { accessToken: string; expiresAt: number }> = {};

async function getAccessToken(account: AccountConfig): Promise<string> {
  const key = account.user;
  const cached = tokenCache[key];
  // 提前 5 分钟刷新
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.accessToken;
  }
  // 需要重新登录
  const token = await headlessLogin(account);
  tokenCache[key] = token;
  return token.accessToken;
}

async function headlessLogin(account: AccountConfig): Promise<{ accessToken: string; expiresAt: number }> {
  const puppeteer = require("puppeteer-core");
  const path = require("node:path");
  const http = require("node:http");
  const { PublicClientApplication } = require("@azure/msal-node");

  const oauth = account.oauth2!;
  const pca = new PublicClientApplication({
    auth: { clientId: oauth.client_id, authority: oauth.authority },
  });

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
    : Date.now() + 55 * 60 * 1000; // 默认 55 分钟

  return { accessToken: response.accessToken, expiresAt };
}

function getAccount(name?: string): AccountConfig {
  if (CONFIG.accounts.length === 0) throw new Error("未配置邮箱账号，请在 settings.json 的 pi-email.accounts 中添加");
  if (!name) return CONFIG.accounts[0];
  const acc = CONFIG.accounts.find(a => a.name === name || a.user === name);
  if (!acc) throw new Error(`未找到邮箱账号 "${name}"，已配置: ${CONFIG.accounts.map(a => a.name).join(", ")}`);
  return acc;
}

// ─── IMAP helper ───
async function withImap<T>(account: AccountConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const isOAuth2 = account.auth_type === "oauth2";
  let auth: any;
  if (isOAuth2) {
    const accessToken = await getAccessToken(account);
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
        const result = await withImap(acc, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const status = await client.status(folder, { messages: true });
            const total = status.messages || 0;

            if (hasFilter) {
              // 有筛选条件：fetch recent batch + filter client-side
              const batchSize = Math.min(limit * 5, 200);
              const start = Math.max(1, total - batchSize + 1);
              const emails: any[] = [];
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
                const isRead = !msg.flags?.has("\\Seen");
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
              return { total, emails: emails.reverse() };
            } else {
              // 无筛选：直接取最新的
              const end = total - offset;
              const start = Math.max(1, end - limit + 1);
              const emails: any[] = [];
              for await (const msg of client.fetch(start + ":" + end, { source: true, flags: true }, { uid: false })) {
                const parsed = await simpleParser(msg.source as Buffer);
                const isRead = !msg.flags?.has("\\Seen");
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
              return { total, emails: emails.reverse() };
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
        const text = `${folder} (${result.total}封，显示最新${result.emails.length}封)\n${lines}`;
        return { content: [{ type: "text", text }], details: { summary: `${folder}: ${result.total}封，显示${result.emails.length}封` } };
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
        const result = await withImap(acc, async (client) => {
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
              isRead: !msg.flags?.has("\\Seen"),
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

        return { content: [{ type: "text", text }], details: { summary: `读取邮件 [${uid}]: ${(result.subject || "").slice(0, 30)}` } };
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
        const folders = await withImap(acc, async (client) => {
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
