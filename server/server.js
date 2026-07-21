// Core AI <-> Roblox Studio bridge server
// Run: npm install && node server.js
//
// This server is intentionally simple (in-memory) so you can see exactly
// how the pieces connect. Swap the Maps for a real DB (Redis/Postgres)
// before you put this in production.

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// Simple health check — also handy for pinging the service awake if you're
// on Render's free tier (which sleeps after ~15 min of no traffic and can
// take 30-50s to spin back up on the next request).
app.get("/", (req, res) => res.json({ ok: true, sessions: sessions.size }));

// session code -> { commands: [], lastSeen, createdAt, robloxUser: null }
const sessions = new Map();

// How recently the Studio plugin must have polled for us to consider it
// "actually online" right now. The plugin polls every 1.5s, so anything
// beyond a few missed polls means Studio was closed / lost connection.
const STUDIO_ONLINE_WINDOW_MS = 5000;

// Sessions nobody has touched in a while are cleaned up so memory doesn't
// grow forever on a long-running instance.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(code);
  }
}, 30 * 60 * 1000);

function makeCode() {
  // Short, human-typeable pairing code, e.g. "7K4P-XQ2M"
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join("");
  return `${part()}-${part()}`;
}

// --- 1. Studio plugin calls this once on startup to create a session ---
app.post("/api/session/create", (req, res) => {
  const code = makeCode();
  sessions.set(code, {
    commands: [],
    lastSeen: Date.now(),   // last time the Studio plugin actually polled us
    createdAt: Date.now(),
    robloxUser: null,       // set once the website "links" this code
  });
  res.json({ code });
});

// --- 2. Website calls this when the user types/confirms the pairing code ---
// NOTE: this only proves the CODE is valid — it does NOT prove Studio is
// currently open and polling. Use /api/session/status's `studioOnline`
// field for that (it's driven by the plugin's poll heartbeat below).
app.post("/api/session/link", (req, res) => {
  const { code, robloxUser } = req.body;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: "Unknown or expired code" });
  session.robloxUser = robloxUser || session.robloxUser || "web-user";
  res.json({ ok: true, studioOnline: Date.now() - session.lastSeen < STUDIO_ONLINE_WINDOW_MS });
});

app.get("/api/session/status", (req, res) => {
  const { code } = req.query;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: "Unknown or expired code" });
  res.json({
    linked: !!session.robloxUser,
    robloxUser: session.robloxUser,
    // True only if the Studio plugin has polled us within the last few
    // seconds. This is the source of truth for "is Studio actually here".
    studioOnline: Date.now() - session.lastSeen < STUDIO_ONLINE_WINDOW_MS,
  });
});

// --- 3. Website pushes a structured command after the AI decides on one ---
//
// NOTE: this whitelist intentionally excludes anything geometry-related.
// The AI can build structure (folders), code (scripts), and UI — never
// parts, meshes, unions, or any 3D object.
const ALLOWED_ACTIONS = new Set([
  "create_folder",
  "create_script",
  "create_ui",
  "delete_instance",
]);

const ALLOWED_ROOTS = new Set([
  "ReplicatedStorage",
  "ServerScriptService",
  "StarterGui",
  "StarterPlayerScripts",
]);

app.post("/api/roblox/command", (req, res) => {
  const { code, command } = req.body;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: "Unknown or expired code" });

  if (!command || !ALLOWED_ACTIONS.has(command.action)) {
    return res.status(400).json({ error: "Rejected: action not in whitelist" });
  }
  // root is required for every action except create_ui targeting ScreenGui
  // (the plugin pins ScreenGuis to StarterGui itself), but we still sanity
  // check it here when present so obviously-bad payloads are rejected early.
  if (command.root && !ALLOWED_ROOTS.has(command.root)) {
    return res.status(400).json({ error: "Rejected: root not in whitelist" });
  }

  session.commands.push(command);
  res.json({ ok: true, queued: session.commands.length });
});

// --- 4. Studio plugin polls this every ~1.5s and executes what comes back ---
app.get("/api/roblox/poll", (req, res) => {
  const { code } = req.query;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: "Unknown or expired code" });
  session.lastSeen = Date.now();
  const commands = session.commands;
  session.commands = [];
  res.json({ commands });
});

// --- Optional: Roblox OAuth callback (fill in your own Client ID/Secret) ---
// See https://create.roblox.com/docs/cloud/auth/oauth2-overview
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || "";
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || "";
const ROBLOX_REDIRECT_URI = process.env.ROBLOX_REDIRECT_URI || "http://localhost:3000/oauth/callback";

app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query; // state = your pairing code, passed through
  if (!ROBLOX_CLIENT_ID || !ROBLOX_CLIENT_SECRET) {
    return res.status(500).send("Set ROBLOX_CLIENT_ID / ROBLOX_CLIENT_SECRET env vars first.");
  }
  try {
    const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ROBLOX_CLIENT_ID,
        client_secret: ROBLOX_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: ROBLOX_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();

    const userRes = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userRes.json();

    // Link this Roblox identity to the pairing session passed in `state`
    const session = sessions.get(state);
    if (session) session.robloxUser = userInfo.preferred_username || userInfo.name;

    res.send(`
      <html><body style="font-family:sans-serif;background:#000;color:#fff;text-align:center;padding:60px">
        <h2>Connected as ${userInfo.preferred_username || "Roblox user"} ✅</h2>
        <p>You can close this tab and go back to Core.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("OAuth exchange failed: " + err.message);
  }
});

app.get("/oauth/login-url", (req, res) => {
  const { state } = req.query; // pairing code
  if (!ROBLOX_CLIENT_ID) return res.status(500).json({ error: "ROBLOX_CLIENT_ID not set" });
  const url = new URL("https://apis.roblox.com/oauth/v1/authorize");
  url.searchParams.set("client_id", ROBLOX_CLIENT_ID);
  url.searchParams.set("redirect_uri", ROBLOX_REDIRECT_URI);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state || "");
  res.json({ url: url.toString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Core bridge server running on http://localhost:${PORT}`));
