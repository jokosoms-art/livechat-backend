// server.js
const express = require("express");
const cors = require("cors");
const { v4: uuid } = require("uuid");

const app = express();

// Enhanced CORS configuration
app.use(cors({
    origin: "*", // Allow all origins for now
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Cache-Control', 'Accept']
}));

app.use(express.json());

// Add specific OPTIONS handling for SSE endpoints
app.options("/livechat/admin/stream", (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Cache-Control, Accept");
    res.status(200).end();
});

app.options("/livechat/stream", (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Cache-Control, Accept");
    res.status(200).end();
});

/* -----------------------------------------------------
   In-Memory Store
----------------------------------------------------- */
const sessions = {}; 
const adminClients = []; 
const clientStreams = {}; 

// Session timeout configuration
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

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
  console.log(`🔔 Notifying ${adminClients.length} admins:`, payload.type);
  
  // Clean up dead connections first
  for (let i = adminClients.length - 1; i >= 0; i--) {
    const res = adminClients[i];
    if (res.writableEnded || res.destroyed) {
      adminClients.splice(i, 1);
      console.log('Removed dead admin connection');
    }
  }
  
  // Send to all active admin clients
  adminClients.forEach((res, index) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      console.log(`✅ Sent to admin ${index}`);
    } catch (error) {
      console.log('Failed to send to admin:', error.message);
    }
  });
}

/* -----------------------------------------------------
   Session Cleanup - AUTO REMOVE EXPIRED SESSIONS
----------------------------------------------------- */
function cleanupExpiredSessions() {
  const now = Date.now();
  let expiredCount = 0;
  
  Object.keys(sessions).forEach(sessionId => {
    const session = sessions[sessionId];
    const sessionAge = now - new Date(session.createdAt).getTime();
    
    if (sessionAge > SESSION_TIMEOUT) {
      console.log(`Cleaning up expired session: ${sessionId}`);
      
      // Notify admins
      notifyAdmins({
        type: "session_expired",
        sessionId,
        userName: session.userName
      });
      
      // Clean up
      delete sessions[sessionId];
      delete clientStreams[sessionId];
      expiredCount++;
    }
  });
  
  if (expiredCount > 0) {
    console.log(`Cleaned up ${expiredCount} expired sessions`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

/* -----------------------------------------------------
   Create Session - IMPROVED NOTIFICATION
----------------------------------------------------- */
app.post("/livechat/request", (req, res) => {
  const { name = "Guest", requestedRole = "support", initialMessages = [] } = req.body;
  const sessionId = uuid();

  // ✅ FIX: Ensure name is never null
  const safeName = name && name !== "null" ? name : "Guest";

  sessions[sessionId] = {
    id: sessionId,
    userName: safeName,
    requestedRole: requestedRole.toLowerCase(),
    agentName: null,
    messages: [...initialMessages],
    createdAt: new Date(),
    lastActivity: new Date()
  };

  console.log(`🆕 New session: ${sessionId} for ${safeName}`);

  // ✅ FIX: Simple, reliable notification
  notifyAdmins({
    type: "new_session",
    sessionId: sessionId,
    userName: safeName,
    requestedRole: requestedRole.toLowerCase(),
    timestamp: new Date().toISOString()
  });

  res.json({ sessionId });
});

/* -----------------------------------------------------
   SSE: Client Stream (for chat widget) - IMPROVED
----------------------------------------------------- */
app.get('/livechat/stream', (req, res) => {
    const sessionId = req.query.sessionId;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID required' });
    }

    console.log(`🔗 Client connected to SSE: ${sessionId}`);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send connection confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

    // Store the client connection
    if (!clientConnections[sessionId]) {
        clientConnections[sessionId] = [];
    }
    clientConnections[sessionId].push(res);

    // Send heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
        if (res.writableEnded) {
            clearInterval(heartbeat);
            return;
        }
        res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
    }, 30000);

    // Clean up on close
    req.on('close', () => {
        console.log(`🔌 Client SSE connection closed: ${sessionId}`);
        clearInterval(heartbeat);
        
        if (clientConnections[sessionId]) {
            clientConnections[sessionId] = clientConnections[sessionId].filter(conn => conn !== res);
            if (clientConnections[sessionId].length === 0) {
                delete clientConnections[sessionId];
            }
        }
    });
});

/* -----------------------------------------------------
   SSE: Admin Stream - ENHANCED CONNECTION HANDLING
----------------------------------------------------- */
app.get("/livechat/admin/stream", (req, res) => {
  console.log("🖥️ Admin dashboard connecting to SSE stream");

  // Enhanced headers for better compatibility
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control, Content-Type, Accept",
    "Access-Control-Expose-Headers": "Content-Type, Cache-Control",
    "X-Accel-Buffering": "no" // Important for some proxies
  });

  const clientId = Math.random().toString(36).substring(7);
  console.log(`Admin client connected: ${clientId}`);

  // Send immediate connection confirmation
  res.write(`data: ${JSON.stringify({ 
    type: "admin_connected", 
    message: "SSE Connected Successfully",
    clientId,
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Send current session data
  const sendInitialData = () => {
    try {
      const waitingSessions = Object.values(sessions).filter(s => !s.agentName);
      res.write(`data: ${JSON.stringify({ 
        type: "initial_data", 
        waitingSessions: waitingSessions.length,
        totalSessions: Object.keys(sessions).length,
        clientId
      })}\n\n`);
    } catch (error) {
      console.log('Initial data send failed');
    }
  };

  // Enhanced heartbeat with error handling
  const heartbeatInterval = setInterval(() => {
    try {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ 
          type: "heartbeat", 
          clientId,
          timestamp: Date.now() 
        })}\n\n`);
      }
    } catch (error) {
      console.log(`💔 Heartbeat failed for client ${clientId}`);
      clearInterval(heartbeatInterval);
    }
  }, 25000); // 25 seconds

  // Send initial data after a short delay
  setTimeout(sendInitialData, 100);

  adminClients.push(res);

  req.on("close", () => {
    console.log(`📴 Admin client disconnected: ${clientId}`);
    clearInterval(heartbeatInterval);
    const index = adminClients.indexOf(res);
    if (index !== -1) {
      adminClients.splice(index, 1);
      console.log(`Remaining admin connections: ${adminClients.length}`);
    }
  });

  req.on("error", (err) => {
    console.log(`❌ Admin stream error for ${clientId}:`, err.message);
    clearInterval(heartbeatInterval);
    const index = adminClients.indexOf(res);
    if (index !== -1) adminClients.splice(index, 1);
  });
});

/* -----------------------------------------------------
   User/Agent Sends a Message - ENHANCED BROADCASTING
----------------------------------------------------- */
app.post('/livechat/send', async (req, res) => {
    try {
        const { sessionId, text, from } = req.body;
        
        if (!sessionId || !text) {
            return res.status(400).json({ error: 'Session ID and text are required' });
        }

        console.log(`📨 Message from ${from} in session ${sessionId}: ${text}`);

        // Store message in session
        if (!sessions[sessionId]) {
            sessions[sessionId] = { messages: [], createdAt: Date.now() };
        }
        
        const message = {
            from: from || 'user',
            text: text,
            timestamp: new Date().toISOString(),
            name: req.body.name || 'Guest'
        };
        
        sessions[sessionId].messages.push(message);
        sessions[sessionId].lastActivity = Date.now();

        // Broadcast to admin (if admin is connected)
        if (adminConnections[sessionId]) {
            adminConnections[sessionId].forEach(adminRes => {
                if (!adminRes.writableEnded) {
                    adminRes.write(`data: ${JSON.stringify(message)}\n\n`);
                }
            });
        }

        res.json({ success: true, message: 'Message sent' });

    } catch (error) {
        console.error('❌ Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/livechat/send', async (req, res) => {
    try {
        const { sessionId, text, from } = req.body;
        
        if (!sessionId || !text) {
            return res.status(400).json({ error: 'Session ID and text are required' });
        }

        console.log(`📨 Message from ${from} in session ${sessionId}: ${text}`);

        // Store message in session
        if (!sessions[sessionId]) {
            sessions[sessionId] = { messages: [], createdAt: Date.now() };
        }
        
        const message = {
            from: from || 'user',
            text: text,
            timestamp: new Date().toISOString(),
            name: req.body.name || 'Guest'
        };
        
        sessions[sessionId].messages.push(message);
        sessions[sessionId].lastActivity = Date.now();

        // Broadcast to admin (if admin is connected)
        if (adminConnections[sessionId]) {
            adminConnections[sessionId].forEach(adminRes => {
                if (!adminRes.writableEnded) {
                    adminRes.write(`data: ${JSON.stringify(message)}\n\n`);
                }
            });
        }

        res.json({ success: true, message: 'Message sent' });

    } catch (error) {
        console.error('❌ Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
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
  sessions[sessionId].lastActivity = new Date();

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
    lastActivity: s.lastActivity,
    timestamp: s.timestamp || s.createdAt
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
   Session Transfer Between Roles
----------------------------------------------------- */
app.post("/livechat/transfer", (req, res) => {
  const { sessionId, targetRole, transferredBy } = req.body;

  if (!sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  const validRoles = ["sales", "consultant", "support", "account"];
  if (!validRoles.includes(targetRole.toLowerCase())) {
    return res.status(400).json({ error: "Invalid target role" });
  }

  const oldRole = sessions[sessionId].requestedRole;
  sessions[sessionId].requestedRole = targetRole.toLowerCase();
  sessions[sessionId].agentName = null; // Unassign current agent
  sessions[sessionId].lastActivity = new Date();

  // Notify admins about transfer
  notifyAdmins({
    type: "session_transferred",
    sessionId,
    userName: sessions[sessionId].userName,
    fromRole: oldRole,
    toRole: targetRole,
    transferredBy,
    timestamp: new Date().toISOString()
  });

  res.json({ 
    success: true, 
    message: `Session transferred from ${oldRole} to ${targetRole}` 
  });
});

/* -----------------------------------------------------
   Connection Test Endpoint
----------------------------------------------------- */
app.get("/livechat/test-connection", (req, res) => {
  res.json({
    status: "ok",
    serverTime: new Date().toISOString(),
    sessions: Object.keys(sessions).length,
    adminConnections: adminClients.length,
    activeClientStreams: Object.keys(clientStreams).length,
    environment: process.env.NODE_ENV || 'development',
    message: "Live Chat Server is running correctly"
  });
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
    activeClientStreams: Object.keys(clientStreams).length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/* -----------------------------------------------------
   Get Session Statistics
----------------------------------------------------- */
app.get("/livechat/stats", (req, res) => {
  const sessionArray = Object.values(sessions);
  
  const stats = {
    total: sessionArray.length,
    byRole: {
      sales: sessionArray.filter(s => s.requestedRole === 'sales').length,
      consultant: sessionArray.filter(s => s.requestedRole === 'consultant').length,
      support: sessionArray.filter(s => s.requestedRole === 'support').length,
      account: sessionArray.filter(s => s.requestedRole === 'account').length
    },
    waiting: sessionArray.filter(s => !s.agentName).length,
    active: sessionArray.filter(s => s.agentName).length,
    adminConnections: adminClients.length,
    timestamp: new Date().toISOString()
  };

  res.json(stats);
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
      messagesCount: s.messages.length,
      lastActivity: s.lastActivity
    }))
  });
});

/* -----------------------------------------------------
   Debug Endpoint - Check Specific Session
----------------------------------------------------- */
app.get("/debug/session/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  
  if (!sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    session: sessions[sessionId],
    hasClientStreams: !!clientStreams[sessionId],
    clientStreamCount: clientStreams[sessionId] ? clientStreams[sessionId].length : 0,
    adminClientCount: adminClients.length
  });
});

/* -----------------------------------------------------
   Debug Endpoint - Send Test Message
----------------------------------------------------- */
app.post("/debug/test-message", (req, res) => {
  const { sessionId, text, from = "client" } = req.body;
  
  if (!sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Simulate a message
  const msg = {
    from,
    text: text || "Test message from debug endpoint",
    time: Date.now(),
    timestamp: new Date().toISOString()
  };

  sessions[sessionId].messages.push(msg);
  sessions[sessionId].lastActivity = new Date();
  
  // Push to customer
  pushToClients(sessionId, msg);

  // Notify admins
  notifyAdmins({
    type: "message",
    sessionId,
    from,
    text: msg.text,
    userName: sessions[sessionId].userName,
    requestedRole: sessions[sessionId].requestedRole,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, message: "Test message sent" });
});

/* -----------------------------------------------------
   Debug Endpoint - Force Notify All Admins
----------------------------------------------------- */
app.post("/debug/force-notify", (req, res) => {
    const { message = "Test notification" } = req.body;
    
    console.log("🔧 Sending forced notification to admins");
    
    notifyAdmins({
        type: "test_notification",
        message,
        timestamp: new Date().toISOString(),
        adminConnections: adminClients.length,
        testData: {
            sessionCount: Object.keys(sessions).length,
            activeSessions: Object.values(sessions).map(s => ({
                id: s.id,
                userName: s.userName,
                role: s.requestedRole,
                agent: s.agentName
            }))
        }
    });
    
    res.json({ 
        success: true, 
        message: "Forced notification sent",
        adminConnections: adminClients.length,
        activeSessions: Object.keys(sessions).length
    });
});

/* -----------------------------------------------------
   Debug Endpoint - List All Sessions
----------------------------------------------------- */
app.get("/debug/sessions", (req, res) => {
    const sessionList = Object.values(sessions).map(session => ({
        id: session.id,
        userName: session.userName,
        requestedRole: session.requestedRole,
        agentName: session.agentName,
        messagesCount: session.messages.length,
        lastActivity: session.lastActivity,
        createdAt: session.createdAt
    }));
    
    res.json({
        totalSessions: sessionList.length,
        sessions: sessionList,
        adminConnections: adminClients.length,
        timestamp: new Date().toISOString()
    });
});

/* -----------------------------------------------------
   Root endpoint
----------------------------------------------------- */
app.get("/", (req, res) => {
  res.json({
    message: "Live Chat Backend Server",
    endpoints: {
      health: "/health",
      testConnection: "/livechat/test-connection",
      adminSSE: "/livechat/admin/stream",
      clientSSE: "/livechat/stream?sessionId=YOUR_SESSION_ID",
      stats: "/livechat/stats",
      debug: "/debug/admin"
    },
    version: "1.0.0"
  });
});

/* -----------------------------------------------------
   Start Server
----------------------------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("=== Live Chat Backend Server ===");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Health check: /health`);
  console.log(`🖥️ Admin SSE: /livechat/admin/stream`);
  console.log(`📱 Client SSE: /livechat/stream`);
  console.log(`🔧 Debug info: /debug/admin`);
  console.log(`⏰ Session timeout: ${SESSION_TIMEOUT / 60000} minutes`);
  console.log("=================================");
});



