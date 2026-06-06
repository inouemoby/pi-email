// Simulate the exact plugin code path for Gmail
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = process.env.USERPROFILE || "";
const PI_AGENT = join(HOME, ".pi", "agent");

// === Copy exact plugin functions ===
const googleTokenCaches: Record<string, any> = {};

function getGoogleCachePath(user: string): string {
  const safe = user.replace(/[^a-zA-Z0-9]/g, "_");
  return join(PI_AGENT, `google-token-cache-${safe}.json`);
}

function loadGoogleCache(user: string): { refreshToken: string; accessToken: string; expiresAt: number } | null {
  const key = user;
  if (googleTokenCaches[key]) return googleTokenCaches[key];
  const cachePath = getGoogleCachePath(user);
  console.log("loadGoogleCache: path =", cachePath);
  const { existsSync } = require("fs");
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf-8"));
      console.log("loadGoogleCache: raw keys =", Object.keys(data));
      const rt = data.refreshToken || data.refresh_token;
      console.log("loadGoogleCache: rt =", !!rt, rt?.slice(0, 20));
      if (rt) {
        const cached = {
          refreshToken: rt,
          accessToken: data.accessToken || data.access_token || "",
          expiresAt: data.expiresAt || Date.now(),
        };
        googleTokenCaches[key] = cached;
        return cached;
      }
    } catch (e: any) { console.log("loadGoogleCache error:", e.message); }
  }
  return null;
}

async function refreshGoogleToken(account: any): Promise<string | null> {
  const cached = loadGoogleCache(account.user);
  console.log("refreshGoogleToken: cached =", !!cached);
  if (!cached?.refreshToken) return null;
  const oauth = account.oauth2;
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
    console.log("refreshGoogleToken: response has access_token:", !!data.access_token, "error:", data.error || "none");
    if (data.access_token) {
      const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      // save
      const key = account.user;
      const saveData = { refreshToken: cached.refreshToken, accessToken: data.access_token, expiresAt };
      googleTokenCaches[key] = saveData;
      try {
        writeFileSync(getGoogleCachePath(account.user), JSON.stringify(saveData));
        console.log("refreshGoogleToken: saved cache");
      } catch (e: any) { console.log("save error:", e.message); }
      return data.access_token;
    }
  } catch (e: any) { console.log("refreshGoogleToken error:", e.message); }
  return null;
}

// === Run the same path as getAccessToken for Gmail ===
console.log("\n=== Simulating getAccessToken for Gmail ===");
const settings = JSON.parse(readFileSync(join(PI_AGENT, "settings.json"), "utf-8"));
const gmailAcc = settings["pi-email"].accounts.find((a: any) => a.name === "Gmail");
console.log("Gmail account:", gmailAcc?.name, gmailAcc?.user);
console.log("Gmail oauth2.provider:", gmailAcc?.oauth2?.provider);

// Step 1: check memory cache (empty on fresh start)
// Step 2: refreshGoogleToken
const token = await refreshGoogleToken(gmailAcc);
console.log("\nFinal token:", !!token, "length:", token?.length);

if (token) {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: gmailAcc.user, accessToken: token }, logger: false as any });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const s = await client.status("INBOX", { messages: true, unseen: true });
  console.log("Gmail IMAP OK:", s.messages, "messages,", s.unseen, "unseen");
  lock.release();
  await client.logout();
}
