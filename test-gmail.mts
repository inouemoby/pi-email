// Test Gmail specifically - run from pi-email dir
import { ImapFlow } from "imapflow";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = process.env.USERPROFILE || "";
const PI_AGENT = join(HOME, ".pi", "agent");
const cachePath = join(PI_AGENT, "google-token-cache-z361904999_gmail_com.json");

console.log("=== Gmail Debug ===");

// 1. Check cache file
const raw = readFileSync(cachePath, "utf-8");
const cached = JSON.parse(raw);
const rt = cached.refreshToken || cached.refresh_token;
console.log("refreshToken exists:", !!rt);
console.log("accessToken exists:", !!cached.accessToken);
console.log("expiresAt:", new Date(cached.expiresAt).toISOString(), "expired:", cached.expiresAt < Date.now());

// 2. Refresh token
console.log("\nRefreshing...");
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com",
    client_secret: "kSmqreRr0qwBWJgbf5Y-PjSU",
    refresh_token: rt,
    grant_type: "refresh_token",
  }),
});
const tokenData = await res.json() as any;
console.log("Refresh response:", tokenData.error ? `ERROR: ${tokenData.error} - ${tokenData.error_description}` : "OK");
console.log("access_token:", !!tokenData.access_token, "length:", tokenData.access_token?.length);

if (!tokenData.access_token) {
  console.log("Cannot continue without access token");
  process.exit(1);
}

// Save refreshed token
const newData = { refreshToken: rt, accessToken: tokenData.access_token, expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000 };
writeFileSync(cachePath, JSON.stringify(newData));
console.log("Saved refreshed token");

// 3. Connect IMAP
console.log("\nConnecting IMAP...");
try {
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: "z361904999@gmail.com", accessToken: tokenData.access_token },
    logger: false as any,
  });
  await client.connect();
  console.log("IMAP connected!");

  const lock = await client.getMailboxLock("INBOX");
  const status = await client.status("INBOX", { messages: true, unseen: true });
  console.log("INBOX:", status.messages, "messages,", status.unseen, "unseen");

  // Try fetching last 3
  const start = Math.max(1, status.messages - 2);
  let count = 0;
  for await (const msg of client.fetch(start + ":" + status.messages, { source: true, flags: true }, { uid: false })) {
    count++;
    const hasSeen = msg.flags?.has("\\\Seen");
    console.log("  seq:", msg.seq, "hasSeen:", hasSeen, "size:", (msg.source as Buffer)?.length);
  }
  console.log("Fetched:", count, "emails");

  lock.release();
  await client.logout();
} catch (e: any) {
  console.log("IMAP ERROR:", e.message);
}
