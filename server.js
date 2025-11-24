// server.js
const express = require("express");
const cors = require("cors");
const { v4: uuid } = require("uuid");

const app = express();

// Use cors middleware properly instead of manual headers
app.use(cors({
  origin: "*",
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Store live chat sessions
const sessions = {};

// Admin SSE clients
let adminClients = [];

/* --------------------------
   ADMIN SSE STREAM
   -------------------------- */
app.get("/admin/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  adminClients.push(res);
  console.log("Admin connected to SSE. Total admins:", adminClients.length);

  const hb = setInterval(() => res.write(":\n\n"), 20000);

  req.on("close", () => {
    clearInterval(hb);
    adminClients = adminClients.filter(c => c !== res);
    console.log("Admin disconnected. Remaining admins:", adminClients.length);
  });
});

// Notify admins
function notifyAdmins(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  adminClients.forEach((c) => {
    try { c.write(data); } catch (e) {}
  });
}

/* --------------------------
   CREATE LIVE AGENT REQUEST (FIXED)
   -------------------------- */
app.post("/livechat/request", (req, res) => {
  const name = req.body.name || "Guest";
  const sessionId = uuid();
  const initialMessages = req.body.initialMessages || [];

  // Create session with ALL initial messages
  sessions[sessionId] = {
    id: sessionId,
    userName: name,
    agentName: null,
    messages: [...initialMessages], // IMPORTANT: Spread the array to create a copy
    clients: []
  };

  console.log("New live chat request:", sessionId, "name:", name, "with", initialMessages.length, "previous messages");

  // Debug: Log what's being stored
  console.log("Stored messages:", sessions[sessionId].messages.length);

  notifyAdmins({ type: "new_session", sessionId, userName: name });

  res.json({ sessionId });
});

/* --------------------------
   USER SSE STREAM
   -------------------------- */
app.get("/livechat/stream", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).end();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });

  console.log("SSE (user) connected for session:", sessionId);
  sessions[sessionId].clients.push(res);

  const heartbeat = setInterval(() => res.write(":\n\n"), 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sessions[sessionId].clients = sessions[sessionId].clients.filter(c => c !== res);
    console.log("SSE (user) disconnected for session:", sessionId);
  });
});

// Push message helper
function pushToClients(sessionId, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const s = sessions[sessionId];
  if (!s) return;

  s.clients.forEach(client => {
    try { client.write(data); } catch (e) {}
  });

  notifyAdmins({ type: "message", sessionId, ...payload });
}

/* --------------------------
   SEND MESSAGE
   -------------------------- */
app.post("/livechat/send", (req, res) => {
  const { sessionId, text, from } = req.body;
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  const msg = { from, text, time: Date.now() };
  sessions[sessionId].messages.push(msg);

  pushToClients(sessionId, msg);

  console.log("Message for session", sessionId, msg);
  res.json({ success: true });
});

/* --------------------------
   ADMIN ASSIGN (UPDATED TO PRESERVE HISTORY)
   -------------------------- */
app.post("/admin/assign", (req, res) => {
  const { sessionId, agentName } = req.body;
  if (!sessionId || !sessions[sessionId]) {
    return res.status(400).json({ error: "Invalid session" });
  }

  sessions[sessionId].agentName = agentName || "Agent";
  console.log(`Session ${sessionId} claimed by ${agentName}. Messages in session:`, sessions[sessionId].messages.length);

  notifyAdmins({ type: "assigned", sessionId, agentName });

  // Send welcome message when agent joins - ADD TO EXISTING MESSAGES
  const welcomeMsg = { 
    from: "agent", 
    text: `👋 Hello! I'm ${agentName}. How can I help you today?`, 
    time: Date.now() 
  };
  sessions[sessionId].messages.push(welcomeMsg);
  pushToClients(sessionId, welcomeMsg);

  res.json({ success: true });
});

/* --------------------------
   GET CHAT HISTORY
   -------------------------- */
app.get("/livechat/history/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  console.log("History requested for session:", sessionId);
  
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Return the messages array for this session
  res.json(sessions[sessionId].messages || []);
});

/* --------------------------
   GET SESSIONS LIST
   -------------------------- */
app.get("/livechat/sessions", (req, res) => {
  const list = Object.values(sessions).map(s => ({
    id: s.id,
    userName: s.userName,
    agentName: s.agentName,
    messagesCount: s.messages.length
  }));
  res.json(list);
});

/* --------------------------
   DEBUG: CHECK SESSION MESSAGES
   -------------------------- */
app.get("/debug/session/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  const session = sessions[sessionId];
  res.json({
    sessionId: session.id,
    userName: session.userName,
    agentName: session.agentName,
    totalMessages: session.messages.length,
    messages: session.messages
  });
});

// FIX: Remove the problematic OPTIONS route entirely
// Since we already have cors() middleware, we don't need manual OPTIONS handling

/* --------------------------
   Start server
   -------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on port " + PORT));
