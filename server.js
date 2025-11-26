// server.js
const express = require("express");
const cors = require("cors");
const { v4: uuid } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

/* -----------------------------------------------------
   In-Memory Store
----------------------------------------------------- */
const sessions = {}; 
const adminClients = []; 
const clientStreams = {}; 

/* -----------------------------------------------------
   SSE Helpers - IMPROVED
----------------------------------------------------- */
function pushToClients(sessionId, message) {
  if (!clientStreams[sessionId]) return;
  
  // Clean up dead connections
  clientStreams[sessionId] = clientStreams[sessionId].filter(res => {
    try {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
      return true;
    } catch (error) {
      console.log('Removing dead client connection');
      return false;
    }
  });
}

function notifyAdmins(payload) {
  console.log(`Notifying ${adminClients.length} admins:`, payload.type);
  
  // Clean up dead admin connections and send notifications
  let activeConnections = 0;
  
  adminClients.forEach((res) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      activeConnections++;
    } catch (error) {
      console.log('Removing dead admin connection');
      // Connection will be removed on close event
    }
  });
  
  console.log(`Successfully notified ${activeConnections} admins`);
}

/* -----------------------------------------------------
   Create Session - IMPROVED NOTIFICATION
----------------------------------------------------- */
app.post("/livechat/request", (req, res) => {
  const { name = "Guest", requestedRole = "support", initialMessages = [] } = req.body;
  const sessionId = uuid();

  // Validate and normalize the role
  const validRoles = ["sales", "consultant", "support", "account"];
  const normalizedRole = validRoles.includes(requestedRole.toLowerCase()) 
    ? requestedRole.toLowerCase() 
    : "support";

  sessions[sessionId] = {
    id: sessionId,
    userName: name,
    requestedRole: normalizedRole,
    agentName: null,
    assignedRole: null,
    messages: [...initialMessages],
    createdAt: new Date(),
    timestamp: new Date().toISOString() // Add for admin panel
  };

  console.log(`New session created: ${sessionId} for role: ${normalizedRole} - User: ${name}`);
  console.log(`Notifying ${adminClients.length} admin clients`);

  // IMPROVED: Send more detailed notification to admins
  notifyAdmins({
    type: "new_session",
    sessionId,
    userName: name,
    requestedRole: normalizedRole,
    timestamp: new Date().toISOString(),
    messagesCount: initialMessages.length,
    id: sessionId // Add id for admin panel compatibility
  });

  res.json({ sessionId });
});

/* -----------------------------------------------------
   SSE: Client Stream (for chat widget)
----------------------------------------------------- */
app.get("/livechat/stream", (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`Client connecting to stream: ${sessionId}`);

  if (!sessionId || !sessions[sessionId]) {
    console.log(`Invalid session: ${sessionId}`);
    return res.status(404).end();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    Connection: "keep-alive"
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

  if (!clientStreams[sessionId]) clientStreams[sessionId] = [];
  clientStreams[sessionId].push(res);

  req.on("close", () => {
    console.log(`Client disconnected from session: ${sessionId}`);
    if (clientStreams[sessionId]) {
      clientStreams[sessionId] = clientStreams[sessionId].filter((r) => r !== res);
    }
  });
});

/* -----------------------------------------------------
   SSE: Admin Stream - IMPROVED CONNECTION HANDLING
----------------------------------------------------- */
app.get("/livechat/admin/stream", (req, res) => {
  console.log("Admin dashboard connecting to stream");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache", 
    "Access-Control-Allow-Origin": "*",
    Connection: "keep-alive",
    "Access-Control-Allow-Headers": "Cache-Control"
  });

  // Send initial connection message with heartbeat
  const sendHeartbeat = () => {
    try {
      res.write(`data: ${JSON.stringify({ type: "heartbeat", timestamp: Date.now() })}\n\n`);
    } catch (error) {
      console.log('Heartbeat failed - connection closed');
    }
  };

  // Send heartbeat every 30 seconds
  const heartbeatInterval = setInterval(sendHeartbeat, 30000);

  // Send connection confirmation
  res.write(`data: ${JSON.stringify({ type: "admin_connected", message: "SSE Connected" })}\n\n`);

  adminClients.push(res);

  req.on("close", () => {
    console.log("Admin dashboard disconnected");
    clearInterval(heartbeatInterval);
    const index = adminClients.indexOf(res);
    if (index !== -1) adminClients.splice(index, 1);
    console.log(`Remaining admin connections: ${adminClients.length}`);
  });

  req.on("error", (err) => {
    console.log("Admin stream error:", err);
    clearInterval(heartbeatInterval);
    const index = adminClients.indexOf(res);
    if (index !== -1) adminClients.splice(index, 1);
  });
});

/* -----------------------------------------------------
   User/Agent Sends a Message - IMPROVED NOTIFICATION
----------------------------------------------------- */
app.post("/livechat/send", (req, res) => {
  const { sessionId, text, from } = req.body;

  console.log(`Message from ${from} in session ${sessionId}: ${text}`);

  if (!sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  const msg = {
    from,
    text,
    time: Date.now(),
    timestamp: new Date().toISOString()
  };

  sessions[sessionId].messages.push(msg);
  
  // Push to customer
  pushToClients(sessionId, msg);

  // IMPROVED: Notify all admins with session context
  if (from === "client") {
    notifyAdmins({
      type: "message",
      sessionId,
      from,
      text,
      userName: sessions[sessionId].userName,
      requestedRole: sessions[sessionId].requestedRole,
      timestamp: new Date().toISOString()
    });
  }

  res.json({ success: true });
});

/* -----------------------------------------------------
   Admin Claims Session - IMPROVED NOTIFICATION
----------------------------------------------------- */
app.post("/livechat/claim", (req, res) => {
  const { sessionId, agentName, agentRole } = req.body;

  console.log(`Claiming session ${sessionId} by ${agentName} (${agentRole})`);

  if (!sessions[sessionId]) {
    return res.status(400).json({ error: "Invalid session" });
  }

  sessions[sessionId].agentName = agentName;
  sessions[sessionId].assignedRole = agentRole.toLowerCase();

  // IMPROVED: Notify all admins about assignment with more details
  notifyAdmins({
    type: "assigned",
    sessionId,
    agentName,
    agentRole: agentRole.toLowerCase(),
    userName: sessions[sessionId].userName,
    requestedRole: sessions[sessionId].requestedRole,
    timestamp: new Date().toISOString()
  });

  // Send welcome message to customer
  const welcomeMsg = {
    from: "agent",
    text: `Hello, I'm ${agentName} from the ${agentRole} team. How can I help you today?`,
    time: Date.now(),
    timestamp: new Date().toISOString()
  };

  sessions[sessionId].messages.push(welcomeMsg);
  pushToClients(sessionId, welcomeMsg);

  res.json({ success: true });
});

/* -----------------------------------------------------
   Get Sessions by Role - IMPROVED FOR ADMIN PANEL
----------------------------------------------------- */
app.get("/livechat/sessions", (req, res) => {
  const { role } = req.query;
  
  let filteredSessions = Object.values(sessions);
  
  // Filter by role if specified - match admin panel expectations
  if (role && role !== 'all') {
    filteredSessions = filteredSessions.filter(
      session => session.requestedRole === role.toLowerCase() && !session.agentName
    );
  }

  const list = filteredSessions.map((s) => ({
    id: s.id,
    userName: s.userName,
    agentName: s.agentName,
    requestedRole: s.requestedRole,
    assignedRole: s.assignedRole,
    messagesCount: s.messages.length,
    lastMessage: s.messages[s.messages.length - 1] || null,
    createdAt: s.createdAt,
    timestamp: s.timestamp || s.createdAt // Ensure timestamp exists
  }));

  console.log(`Returning ${list.length} sessions for role: ${role || 'all'}`);
  res.json(list);
});

/* -----------------------------------------------------
   Get Session by ID (for admin panel)
----------------------------------------------------- */
app.get("/livechat/session/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  
  if (!sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json(sessions[sessionId]);
});

/* -----------------------------------------------------
   Full Chat History
----------------------------------------------------- */
app.get("/livechat/history/:sessionId", (req, res) => {
  const id = req.params.sessionId;

  if (!sessions[id]) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json(sessions[id].messages);
});

/* -----------------------------------------------------
   Close Session (cleanup)
----------------------------------------------------- */
app.post("/livechat/close", (req, res) => {
  const { sessionId } = req.body;

  if (!sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Notify admins about session closure
  notifyAdmins({
    type: "session_closed",
    sessionId,
    userName: sessions[sessionId].userName
  });

  // Clean up
  delete sessions[sessionId];
  delete clientStreams[sessionId];

  res.json({ success: true });
});

/* -----------------------------------------------------
   Health Check with Admin Info
----------------------------------------------------- */
app.get("/health", (req, res) => {
  const waitingSessions = Object.values(sessions).filter(s => !s.agentName);
  
  res.json({ 
    status: "ok", 
    totalSessions: Object.keys(sessions).length,
    waitingSessions: waitingSessions.length,
    adminClients: adminClients.length,
    activeClientStreams: Object.keys(clientStreams).length
  });
});

/* -----------------------------------------------------
   Debug Endpoint - Check Admin Connections
----------------------------------------------------- */
app.get("/debug/admin", (req, res) => {
  res.json({
    adminConnections: adminClients.length,
    sessions: Object.keys(sessions).length,
    sessionDetails: Object.values(sessions).map(s => ({
      id: s.id,
      userName: s.userName,
      requestedRole: s.requestedRole,
      agentName: s.agentName,
      messagesCount: s.messages.length
    }))
  });
});

/* -----------------------------------------------------
   Start Server
----------------------------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("=== Live Chat Backend Server ===");
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin SSE: /livechat/admin/stream`);
  console.log(`Health check: /health`);
  console.log(`Debug info: /debug/admin`);
  console.log("================================");
});
