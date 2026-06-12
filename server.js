const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory storage for users and messages
const users = new Map();
const chatHistory = [];
const leaderboard = [];

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  // User joins live room
  socket.on('user-join', (userData) => {
    users.set(socket.id, userData);
    io.emit('user-joined', {
      message: `${userData.name} joined the study room`,
      totalUsers: users.size
    });
    console.log(`👤 ${userData.name} joined. Total users: ${users.size}`);
  });

  // Chat message
  socket.on('chat-message', (msg) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now(),
      user: user.name,
      avatar: user.initials,
      text: msg.text,
      timestamp: new Date().toLocaleTimeString(),
      socketId: socket.id
    };

    chatHistory.push(message);
    io.emit('chat-message', message);
    console.log(`💬 ${user.name}: ${msg.text.substring(0, 50)}`);
  });

  // Ping notification
  socket.on('ping-user', (targetId) => {
    const pinger = users.get(socket.id);
    if (!pinger) return;

    io.emit('ping-notification', {
      from: pinger.name,
      message: `${pinger.name} pinged the group! 📢`,
      timestamp: new Date().toLocaleTimeString()
    });
    console.log(`📢 ${pinger.name} pinged`);
  });

  // Update leaderboard with user progress
  socket.on('update-progress', (progressData) => {
    const user = users.get(socket.id);
    if (!user) return;

    const existingEntry = leaderboard.find(e => e.socketId === socket.id);
    if (existingEntry) {
      existingEntry.points = progressData.points;
      existingEntry.completion = progressData.completion;
    } else {
      leaderboard.push({
        socketId: socket.id,
        name: user.name,
        points: progressData.points,
        completion: progressData.completion
      });
    }

    // Sort by points descending
    leaderboard.sort((a, b) => b.points - a.points);
    io.emit('leaderboard-update', leaderboard);
  });

  // User disconnects
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    users.delete(socket.id);
    leaderboard.splice(leaderboard.findIndex(e => e.socketId === socket.id), 1);

    if (user) {
      io.emit('user-left', {
        message: `${user.name} left the study room`,
        totalUsers: users.size
      });
      console.log(`❌ ${user.name} disconnected. Total users: ${users.size}`);
    }
  });
});

// ==================== API ENDPOINTS ====================

// Gemini AI endpoint - Answer legal questions
app.post('/api/gemini-ask', async (req, res) => {
  try {
    const { question, context, userId } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const lawContext = {
      'dpa': `You are an expert legal advisor specializing in Philippine Data Privacy Act (R.A. 10173). 
              Provide clear, concise, and accurate legal explanations in the context of Philippine law. 
              Include relevant sections and practical examples when applicable.`,
      'eco': `You are an expert legal advisor specializing in Philippine E-Commerce Act (R.A. 8792). 
              Explain electronic contracts, digital signatures, and cyber offenses in Philippine context.
              Cite relevant sections and provide practical scenarios.`,
      'eodb': `You are an expert legal advisor specializing in Philippine Ease of Doing Business Act (R.A. 11032). 
               Focus on business registration, government service delivery, and regulatory compliance.`,
      'labor': `You are an expert legal advisor specializing in Philippine Labor Code (P.D. 442). 
               Explain employment rights, obligations, and labor dispute resolution in Philippine context.`,
      'ssl': `You are an expert legal advisor specializing in Philippine Social Security Law of 2018 (R.A. 11199). 
              Cover social security benefits, contributions, and employee protection.`,
      'assessment': `You are an expert legal educator providing comprehensive assessments on Philippine laws. 
                     Evaluate understanding and suggest learning focus areas.`
    };

    const systemPrompt = lawContext[context] || lawContext['assessment'];
    const fullPrompt = `${systemPrompt}\n\nUser Question: ${question}\n\nProvide a detailed, educational response suitable for law students.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent(fullPrompt);
    const answer = result.response.text();

    console.log(`🤖 Gemini response for ${context} context`);
    res.json({ answer, context });
  } catch (error) {
    console.error('❌ Gemini API error:', error);
    res.status(500).json({ error: 'Failed to generate AI response. Check API key.' });
  }
});

// Get AI Assessment
app.post('/api/ai-assessment', async (req, res) => {
  try {
    const { userId, progressData } = req.body;

    const prompt = `As a legal education expert, analyze this student's progress and provide:
1. Overall mastery level
2. Strengths in understanding
3. Areas needing focus
4. Personalized study recommendations

Progress Data:
- DPA Completion: ${progressData.dpa}%
- E-Commerce Completion: ${progressData.eco}%
- EODB Completion: ${progressData.eodb}%
- Labor Code Completion: ${progressData.labor}%
- SS Law Completion: ${progressData.ssl}%
- Total Points: ${progressData.points}

Provide structured, encouraging feedback.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent(prompt);
    const assessment = result.response.text();

    console.log(`📊 Generated AI assessment for user ${userId}`);
    res.json({ assessment });
  } catch (error) {
    console.error('❌ Assessment generation error:', error);
    res.status(500).json({ error: 'Failed to generate assessment' });
  }
});

// Get chat history
app.get('/api/chat-history', (req, res) => {
  res.json({ messages: chatHistory, totalMessages: chatHistory.length });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  const ranked = leaderboard.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    rankClass: index === 0 ? 'gold-rank' : index === 1 ? 'silver-rank' : index === 2 ? 'bronze-rank' : ''
  }));
  res.json({ leaderboard: ranked });
});

// Get active users
app.get('/api/active-users', (req, res) => {
  const activeUsers = Array.from(users.values());
  res.json({ users: activeUsers, count: activeUsers.length });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    users: users.size,
    messages: chatHistory.length
  });
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🏛️  Philippine Law Review Server      ║
║  Port: ${PORT}                          ║
║  Status: 🟢 Running                    ║
╚════════════════════════════════════════╝
  `);
});

module.exports = { app, server, io };
