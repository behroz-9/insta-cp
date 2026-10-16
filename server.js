const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// Initialize Database
const db = new sqlite3.Database('./chat_database.db', (err) => {
  if (err) console.error('Database opening error: ', err.message);
  else console.log('Connected to SQLite database.');
});

// Database Schema Creation
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    message TEXT,
    reply_to INTEGER,
    timestamp TEXT,
    is_deleted INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower TEXT,
    following TEXT,
    UNIQUE(follower, following)
  )`);
});

// --- REST API ROUTES ---

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ success: false, error: 'All fields are required.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
      [username, email, hashedPassword],
      function (err) {
        if (err) {
          return res.status(400).json({ success: false, error: 'Username or Email already exists.' });
        }
        res.json({ success: true, userId: this.lastID });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error during registration.' });
  }
});

app.post('/api/login', (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ success: false, error: 'Please enter your credentials.' });
  }

  db.get(
    `SELECT * FROM users WHERE email = ? OR username = ?`,
    [identifier, identifier],
    async (err, user) => {
      if (err) return res.status(500).json({ success: false, error: 'Database error.' });
      if (!user) return res.status(401).json({ success: false, error: 'Invalid email/username or password.' });

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, error: 'Invalid email/username or password.' });
      }

      res.json({ success: true, username: user.username, email: user.email });
    }
  );
});

app.get('/api/users/:currentUser', (req, res) => {
  const { currentUser } = req.params;
  db.all(`SELECT username, email FROM users WHERE username != ?`, [currentUser], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/follow', (req, res) => {
  const { follower, following } = req.body;
  db.run(`INSERT OR IGNORE INTO follows (follower, following) VALUES (?, ?)`, [follower, following], (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/unfollow', (req, res) => {
  const { follower, following } = req.body;
  db.run(`DELETE FROM follows WHERE follower = ? AND following = ?`, [follower, following], (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/following/:username', (req, res) => {
  const { username } = req.params;
  db.all(`SELECT following FROM follows WHERE follower = ?`, [username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.following));
  });
});

app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  db.all(
    `SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC`,
    [user1, user2, user2, user1],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// --- SOCKET.IO REALTIME ---
io.on('connection', (socket) => {
  socket.on('join_room', (username) => { socket.join(username); });

  socket.on('send_message', (data) => {
    const { sender, receiver, message, reply_to, timestamp } = data;
    db.run(
      `INSERT INTO messages (sender, receiver, message, reply_to, timestamp, is_deleted) VALUES (?, ?, ?, ?, ?, 0)`,
      [sender, receiver, message, reply_to || null, timestamp],
      function (err) {
        if (!err) {
          const msgObj = { id: this.lastID, sender, receiver, message, reply_to: reply_to || null, timestamp, is_deleted: 0 };
          io.to(receiver).emit('receive_message', msgObj);
          io.to(sender).emit('receive_message', msgObj);
        }
      }
    );
  });

  socket.on('delete_message', (data) => {
    const { messageId, sender, receiver } = data;
    db.run(`UPDATE messages SET is_deleted = 1, message = 'This message was unsent' WHERE id = ?`, [messageId], (err) => {
      if (!err) {
        io.to(sender).emit('message_deleted', { messageId });
        io.to(receiver).emit('message_deleted', { messageId });
      }
    });
  });
});

// --- FRONTEND ---
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Instagram Direct</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0b0b0b; color: #f5f5f5; height: 100vh; display: flex; justify-content: center; align-items: center; }
    .hidden { display: none !important; }

    .auth-container { width: 350px; background: #121212; border: 1px solid #262626; padding: 40px 30px; border-radius: 12px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
    .auth-container h1 { font-family: cursive; font-size: 38px; margin-bottom: 25px; color: #fff; font-weight: normal; }
    .auth-container input { width: 100%; padding: 10px 12px; margin-bottom: 10px; background: #121212; border: 1px solid #363636; border-radius: 6px; color: #fff; font-size: 14px; }
    .auth-container input:focus { border-color: #a8a8a8; outline: none; }
    .auth-btn { width: 100%; background: #0095f6; color: #fff; border: none; padding: 9px; border-radius: 8px; font-weight: 600; cursor: pointer; margin-top: 10px; font-size: 14px; }
    .auth-btn:hover { background: #1877f2; }
    .toggle-auth { margin-top: 20px; font-size: 14px; color: #a8a8a8; cursor: pointer; }
    .error-msg { color: #ed4956; font-size: 13px; margin-top: 10px; }

    .app-container { display: flex; width: 980px; height: 92vh; background: #000; border: 1px solid #262626; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8); }
    .sidebar { width: 350px; border-right: 1px solid #262626; display: flex; flex-direction: column; background: #000; }
    .sidebar-header { padding: 18px 20px; font-size: 18px; font-weight: 700; border-bottom: 1px solid #262626; display: flex; justify-content: space-between; align-items: center; }
    
    .search-box-container { padding: 12px 15px; border-bottom: 1px solid #262626; }
    .search-box-container input { width: 100%; padding: 8px 14px; background: #262626; border: none; border-radius: 8px; color: #fff; font-size: 13px; outline: none; }
    
    .user-list { overflow-y: auto; flex: 1; }
    .user-item { padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background 0.2s; border-bottom: 1px solid #121212; }
    .user-item:hover { background: #121212; }
    .user-item.active { background: #1a1a1a; }
    
    .user-info-left { display: flex; align-items: center; flex: 1; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 12px; color: #fff; font-size: 16px; flex-shrink: 0; }
    
    .follow-btn { background: #0095f6; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer; }
    .follow-btn.following { background: #262626; color: #f5f5f5; }
    .follow-btn:hover { opacity: 0.9; }

    .chat-window { flex: 1; display: flex; flex-direction: column; background: #000; }
    .chat-header { padding: 18px 20px; border-bottom: 1px solid #262626; font-weight: 600; font-size: 15px; display: flex; align-items: center; }
    .messages-container { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; background: radial-gradient(circle at center, #121212 0%, #000000 100%); }
    
    .message-bubble { max-width: 65%; padding: 10px 14px; border-radius: 18px; font-size: 14px; position: relative; word-break: break-word; }
    .message-bubble.sent { background: #3797f0; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .message-bubble.received { background: #262626; color: #f5f5f5; align-self: flex-start; border-bottom-left-radius: 4px; }
    .message-bubble.deleted .msg-text { font-style: italic; opacity: 0.6; }
    
    .message-meta { font-size: 10px; margin-top: 4px; color: rgba(255,255,255,0.7); display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
    .action-btn { cursor: pointer; color: #ff3b30; font-weight: bold; display: none; }
    .reply-btn { cursor: pointer; color: #a8a8a8; display: none; }
    .message-bubble:hover .action-btn, .message-bubble:hover .reply-btn { display: inline; }

    .reply-preview-bar { background: #121212; padding: 8px 15px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; border-top: 1px solid #262626; color: #a8a8a8; }
    .cancel-reply { cursor: pointer; color: #0095f6; font-weight: 600; }

    .chat-input-area { padding: 15px 20px; border-top: 1px solid #262626; display: flex; align-items: center; background: #000; }
    .chat-input-area input { flex: 1; background: #121212; border: 1px solid #363636; border-radius: 22px; padding: 12px 18px; color: #fff; font-size: 14px; outline: none; }
    .chat-input-area input:focus { border-color: #a8a8a8; }
    .chat-input-area button { background: transparent; border: none; color: #0095f6; font-weight: 600; margin-left: 12px; cursor: pointer; font-size: 14px; }
    .chat-input-area button:disabled { color: #363636; cursor: default; }
  </style>
</head>
<body>

  <!-- AUTH FORM -->
  <div id="authBox" class="auth-container">
    <h1>Instagram</h1>
    <form id="authForm">
      <input type="text" id="usernameInput" placeholder="Username (for signup)" class="hidden">
      <input type="text" id="identifierInput" placeholder="Phone number, username, or email" required>
      <input type="password" id="passwordInput" placeholder="Password" required>
      <button type="submit" id="authSubmitBtn" class="auth-btn">Log In</button>
      <div id="authError" class="error-msg"></div>
    </form>
    <div class="toggle-auth" id="toggleAuthMode">Don't have an account? <b>Sign up</b></div>
  </div>

  <!-- MAIN APP -->
  <div id="appBox" class="app-container hidden">
    <div class="sidebar">
      <div class="sidebar-header">
        <span id="currentLoggedInUser"></span>
        <button id="logoutBtn" style="background:none; border:none; color:#ed4956; cursor:pointer; font-weight:600; font-size:13px;">Log Out</button>
      </div>
      
      <div class="search-box-container">
        <input type="text" id="searchInput" placeholder="Search people...">
      </div>

      <div class="user-list" id="userList"></div>
    </div>

    <div class="chat-window">
      <div class="chat-header" id="chatHeader">Select a chat to start messaging</div>
      <div class="messages-container" id="messagesContainer"></div>
      
      <div id="replyPreviewBar" class="reply-preview-bar hidden">
        <div>Replying: <i id="replyingToText"></i></div>
        <span class="cancel-reply" id="cancelReplyBtn">Cancel</span>
      </div>

      <form class="chat-input-area" id="chatForm">
        <input type="text" id="messageInput" placeholder="Message..." autocomplete="off" disabled>
        <button type="submit" id="sendBtn" disabled>Send</button>
      </form>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    let isSignUp = false, currentUser = null, activeRecipient = null, replyingToMessageId = null;
    let allUsers = [], followingList = [];

    const authBox = document.getElementById('authBox'), appBox = document.getElementById('appBox');
    const authForm = document.getElementById('authForm'), authSubmitBtn = document.getElementById('authSubmitBtn');
    const usernameInput = document.getElementById('usernameInput'), identifierInput = document.getElementById('identifierInput'), passwordInput = document.getElementById('passwordInput');
    const authError = document.getElementById('authError'), toggleAuthMode = document.getElementById('toggleAuthMode');
    const currentLoggedInUser = document.getElementById('currentLoggedInUser'), userList = document.getElementById('userList');
    const searchInput = document.getElementById('searchInput'), chatHeader = document.getElementById('chatHeader');
    const messagesContainer = document.getElementById('messagesContainer'), chatForm = document.getElementById('chatForm');
    const messageInput = document.getElementById('messageInput'), sendBtn = document.getElementById('sendBtn');
    const replyPreviewBar = document.getElementById('replyPreviewBar'), replyingToText = document.getElementById('replyingToText'), cancelReplyBtn = document.getElementById('cancelReplyBtn');

    toggleAuthMode.addEventListener('click', () => {
      isSignUp = !isSignUp;
      usernameInput.classList.toggle('hidden', !isSignUp);
      authSubmitBtn.innerText = isSignUp ? 'Sign Up' : 'Log In';
      toggleAuthMode.innerHTML = isSignUp ? 'Have an account? <b>Log in</b>' : "Don't have an account? <b>Sign up</b>";
      authError.innerText = '';
    });

    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      authError.innerText = '';
      const password = passwordInput.value;

      if (isSignUp) {
        const username = usernameInput.value.trim(), email = identifierInput.value.trim();
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password })
        });
        const data = await res.json();
        if (data.success) { alert('Account Created Successfully! Please Log In.'); toggleAuthMode.click(); }
        else { authError.innerText = data.error; }
      } else {
        const identifier = identifierInput.value.trim();
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();
        if (data.success) {
          currentUser = data.username;
          socket.emit('join_room', currentUser);
          authBox.classList.add('hidden');
          appBox.classList.remove('hidden');
          currentLoggedInUser.innerText = '@' + currentUser;
          fetchAppData();
        } else { authError.innerText = data.error; }
      }
    });

    document.getElementById('logoutBtn').addEventListener('click', () => window.location.reload());

    async function fetchAppData() {
      await fetchFollowing();
      await fetchUsers();
    }

    async function fetchFollowing() {
      const res = await fetch('/api/following/' + currentUser);
      followingList = await res.json();
    }

    async function fetchUsers() {
      const res = await fetch('/api/users/' + currentUser);
      allUsers = await res.json();
      renderUserList(allUsers);
    }

    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      const filtered = allUsers.filter(u => u.username.toLowerCase().includes(term));
      renderUserList(filtered);
    });

    function renderUserList(users) {
      userList.innerHTML = '';
      if (users.length === 0) {
        userList.innerHTML = '<div style="padding: 20px; text-align: center; color: #737373; font-size: 13px;">No users found</div>';
        return;
      }

      users.forEach(u => {
        const isFollowing = followingList.includes(u.username);
        const div = document.createElement('div');
        div.className = 'user-item ' + (activeRecipient === u.username ? 'active' : '');
        
        div.innerHTML = \`
          <div class="user-info-left" onclick="selectChat('\${u.username}')">
            <div class="avatar">\${u.username.charAt(0).toUpperCase()}</div>
            <div>
              <div style="font-weight: 600; font-size: 14px;">\${u.username}</div>
              <div style="font-size: 12px; color: #a8a8a8;">\${isFollowing ? 'Following' : 'Not following'}</div>
            </div>
          </div>
          <button class="follow-btn \${isFollowing ? 'following' : ''}" onclick="toggleFollow(event, '\${u.username}')">
            \${isFollowing ? 'Following' : 'Follow'}
          </button>
        \`;
        userList.appendChild(div);
      });
    }

    window.toggleFollow = async (e, username) => {
      e.stopPropagation();
      const isFollowing = followingList.includes(username);
      const endpoint = isFollowing ? '/api/unfollow' : '/api/follow';
      
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ follower: currentUser, following: username })
      });
      const data = await res.json();
      if (data.success) {
        await fetchFollowing();
        renderUserList(allUsers);
      }
    };

    window.selectChat = (username) => {
      activeRecipient = username;
      chatHeader.innerText = '@' + activeRecipient;
      messageInput.disabled = false;
      sendBtn.disabled = false;
      renderUserList(allUsers);
      loadMessages();
    };

    async function loadMessages() {
      if (!activeRecipient) return;
      const res = await fetch('/api/messages/' + currentUser + '/' + activeRecipient);
      const messages = await res.json();
      messagesContainer.innerHTML = '';
      messages.forEach(msg => appendMessageToDOM(msg));
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = messageInput.value.trim();
      if (!text || !activeRecipient) return;

      const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      socket.emit('send_message', {
        sender: currentUser,
        receiver: activeRecipient,
        message: text,
        reply_to: replyingToMessageId,
        timestamp: timeString
      });
      messageInput.value = false ? '' : ''; // safe clear
      messageInput.value = '';
      cancelReply();
    });

    socket.on('receive_message', (msg) => {
      if ((msg.sender === currentUser && msg.receiver === activeRecipient) ||
          (msg.sender === activeRecipient && msg.receiver === currentUser)) {
        appendMessageToDOM(msg);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    });

    socket.on('message_deleted', (data) => {
      const msgElement = document.getElementById('msg-' + data.messageId);
      if (msgElement) {
        msgElement.querySelector('.msg-text').innerText = 'This message was unsent';
        msgElement.classList.add('deleted');
        const delBtn = msgElement.querySelector('.action-btn');
        if (delBtn) delBtn.remove();
      }
    });

    function appendMessageToDOM(msg) {
      const div = document.createElement('div');
      div.id = 'msg-' + msg.id;
      const isSentByMe = msg.sender === currentUser;
      div.className = 'message-bubble ' + (isSentByMe ? 'sent' : 'received') + (msg.is_deleted ? ' deleted' : '');

      let replyHtml = msg.reply_to ? '<div style="font-size:11px;opacity:0.8;border-left:2px solid #fff;padding-left:4px;margin-bottom:4px;">Replying to message</div>' : '';

      let actionsHtml = '';
      if (!msg.is_deleted) {
        actionsHtml += '<span class="reply-btn" onclick="setupReply(' + msg.id + ', \\'' + msg.message.replace(/'/g, "\\\\'") + '\\">Reply</span>';
        if (isSentByMe) {
          actionsHtml += '<span class="action-btn" onclick="deleteMessage(' + msg.id + ')">Unsend</span>';
        }
      }

      div.innerHTML = \`
        \${replyHtml}
        <div class="msg-text">\${msg.message}</div>
        <div class="message-meta">
          <span>\${msg.timestamp}</span>
          \${actionsHtml}
        </div>
      \`;
      messagesContainer.appendChild(div);
    }

    window.deleteMessage = (messageId) => {
      if (confirm('Unsend this message for everyone?')) {
        socket.emit('delete_message', { messageId, sender: currentUser, receiver: activeRecipient });
      }
    };

    window.setupReply = (msgId, text) => {
      replyingToMessageId = msgId;
      replyingToText.innerText = text;
      replyPreviewBar.classList.remove('hidden');
    };

    cancelReplyBtn.addEventListener('click', cancelReply);
    function cancelReply() {
      replyingToMessageId = null;
      replyPreviewBar.classList.add('hidden');
    }
  </script>
</body>
</html>
  `);
});

// Dynamic port for Public Cloud Hosting (Render, Heroku, etc.)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running live on port ${PORT}`);
});