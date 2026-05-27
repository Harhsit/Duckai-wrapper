const express = require('express');
const cors = require('cors');

const app = express();

// 🌐 FULLY OPEN CORS (Cross-Origin Allowed for All)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '10mb' }));

// 🔑 API KEY SETUP
// Tu ise Vercel/Render ke Environment Variables me DUCK_AI_API_KEY naam se set kar sakta hai.
// Agar set nahi karega toh default me "bhai_duck_ai_secure_token_2026" use hogi.
const API_KEY = process.env.DUCK_AI_API_KEY || "bhai_duck_ai_secure_token_2026";

// 🤖 SUPPORTED MODELS LIST (Centralized)
const SUPPORTED_MODELS = [
    { id: 'gpt-4o-mini', name: 'OpenAI GPT-4o Mini', tag: 'Default & Fastest' },
    { id: 'gpt-5-mini', name: 'OpenAI GPT 5 Mini', tag: 'Latest' },
    { id: 'gpt-oss-120b', name: 'OpenAI OSS 120B', tag: 'Open Source' },
    { id: 'claude-4.5-haiku', name: 'Anthropic Claude 4.5 Haiku', tag: 'Smart' },
    { id: 'llama-4-scout', name: 'Meta Llama 4 Scout', tag: 'Open Weights' },
    { id: 'mistral-small-3-24b', name: 'Mistral Small 3 (24B)', tag: 'Efficient' }
];

// 🛡️ API KEY VALIDATION MIDDLEWARE
const validateApiKey = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const customKeyHeader = req.headers['x-api-key'];

    let userKey = "";

    // Check Authorization: Bearer <KEY>
    if (authHeader && authHeader.startsWith('Bearer ')) {
        userKey = authHeader.split(' ')[1].trim();
    } else if (customKeyHeader) {
        userKey = String(customKeyHeader).trim();
    }

    if (!userKey || userKey !== API_KEY) {
        return res.status(401).json({
            status: "error",
            message: "Unauthorized! Bhai galat ya missing API Key hai. Header me sahi key bhejo.",
            hint: "Use 'Authorization: Bearer <KEY>' OR 'x-api-key: <KEY>' header."
        });
    }
    next();
};

// 📄 HOME ROUTE - BEAUTIFUL HTML DOCUMENTATION
app.get('/', (req, res) => {
    const modelsListHtml = SUPPORTED_MODELS.map(m =>
        `<li><code>${m.id}</code> <span class="tag">${m.tag}</span> &mdash; ${m.name}</li>`
    ).join('');

    const htmlDocs = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🦆 Duck AI Professional API — Documentation</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
            color: #e2e8f0;
            margin: 0;
            padding: 40px 20px;
            line-height: 1.7;
            min-height: 100vh;
        }
        .container {
            max-width: 920px;
            margin: 0 auto;
            background: rgba(30, 41, 59, 0.85);
            backdrop-filter: blur(10px);
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            border: 1px solid rgba(148, 163, 184, 0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        h1 {
            color: #38bdf8;
            font-size: 2.5em;
            margin: 0 0 10px 0;
            background: linear-gradient(90deg, #38bdf8, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .subtitle { color: #94a3b8; font-size: 1.1em; }
        h2 {
            color: #f1f5f9;
            margin-top: 40px;
            border-bottom: 2px solid #334155;
            padding-bottom: 10px;
            font-size: 1.6em;
        }
        h3 { color: #cbd5e1; margin-top: 25px; }
        .badge {
            background: #0284c7;
            color: white;
            padding: 5px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: bold;
            letter-spacing: 0.5px;
        }
        .badge-post { background: #10b981; }
        .badge-get { background: #6366f1; }
        .tag {
            display: inline-block;
            background: #1e293b;
            color: #fbbf24;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            margin-left: 6px;
            border: 1px solid #334155;
        }
        code {
            background: #0f172a;
            padding: 3px 8px;
            border-radius: 4px;
            font-family: "Fira Code", "Courier New", monospace;
            color: #f472b6;
            font-size: 0.92em;
            border: 1px solid #1e293b;
        }
        pre {
            background: #020617;
            padding: 18px;
            border-radius: 10px;
            overflow-x: auto;
            border: 1px solid #1e293b;
            position: relative;
        }
        pre code {
            color: #7dd3fc;
            background: none;
            padding: 0;
            border: none;
            font-size: 0.9em;
            line-height: 1.6;
        }
        ul { padding-left: 22px; }
        li { margin-bottom: 10px; }
        .endpoint-box {
            background: #111827;
            padding: 18px;
            border-left: 4px solid #10b981;
            border-radius: 0 10px 10px 0;
            margin: 20px 0;
        }
        .endpoint-box.get { border-left-color: #6366f1; }
        .info-card {
            background: rgba(56, 189, 248, 0.08);
            border: 1px solid rgba(56, 189, 248, 0.3);
            padding: 15px 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        .warning-card {
            background: rgba(251, 191, 36, 0.08);
            border: 1px solid rgba(251, 191, 36, 0.3);
            padding: 15px 20px;
            border-radius: 10px;
            margin: 20px 0;
            color: #fde68a;
        }
        footer {
            text-align: center;
            margin-top: 40px;
            color: #64748b;
            font-size: 0.9em;
        }
        .status-pill {
            display: inline-block;
            background: #10b981;
            color: white;
            padding: 4px 14px;
            border-radius: 50px;
            font-size: 0.85em;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🦆 Duck AI Professional API</h1>
            <p class="subtitle">A secure, production-ready wrapper around DuckDuckGo AI Chat</p>
            <p><span class="status-pill">● LIVE</span></p>
        </div>

        <div class="info-card">
            <strong>👋 Welcome bhai!</strong> Tera khud ka custom AI API gateway bilkul taiyar hai.
            Tu ise kisi bhi app, frontend website, ya automation script me hit kar sakta hai. Niche
            saari details, models aur examples diye gaye hain.
        </div>

        <h2>🔑 Authentication</h2>
        <p>Is API ko secure rakha gaya hai. Har request ke HTTP Headers me teri API Key honi chahiye. Tu in dono me se koi bhi header use kar sakta hai:</p>
        <pre><code>Authorization: Bearer YOUR_API_KEY
// OR
x-api-key: YOUR_API_KEY</code></pre>

        <div class="warning-card">
            <strong>⚠️ Default Testing Key:</strong> <code>bhai_duck_ai_secure_token_2026</code><br>
            Production me Vercel/Render Environment Variables me <code>DUCK_AI_API_KEY</code> set karke apni custom key use kar.
        </div>

        <h2>🚀 Endpoints</h2>

        <div class="endpoint-box get">
            <span class="badge badge-get">GET</span> <code>/</code>
            <p>Ye documentation page jo tu abhi padh raha hai. (No auth required)</p>
        </div>

        <div class="endpoint-box">
            <span class="badge badge-post">POST</span> <code>/api/chat</code>
            <p>Sends a prompt to the selected AI model and returns a full unified text response. <strong>(Auth required)</strong></p>
        </div>

        <h3>📥 Request Body (JSON)</h3>
        <pre><code>{
  "message": "Bhai black hole kya hota hai?",
  "model": "gpt-4o-mini"   // Optional, default = gpt-4o-mini
}</code></pre>

        <h3>🤖 Supported Models</h3>
        <p>Pass any of these inside the <code>"model"</code> field:</p>
        <ul>
            ${modelsListHtml}
        </ul>

        <h3>📤 Response Example (JSON)</h3>
        <pre><code>{
  "status": "success",
  "model_used": "gpt-4o-mini",
  "reply": "Black hole space me ek aisi jagah hoti hai jahan gravity itni zyada hoti hai ki light bhi escape nahi kar sakti..."
}</code></pre>

        <h2>🛠️ Quick Fetch Example (JavaScript)</h2>
        <pre><code>fetch(window.location.origin + '/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer bhai_duck_ai_secure_token_2026'
  },
  body: JSON.stringify({
    message: 'Hello AI! Tell me a joke.',
    model: 'claude-4.5-haiku'
  })
})
.then(res => res.json())
.then(data => console.log(data.reply))
.catch(err => console.error(err));</code></pre>

        <h2>🐚 cURL Example</h2>
        <pre><code>curl -X POST https://your-domain.vercel.app/api/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer bhai_duck_ai_secure_token_2026" \\
  -d '{"message":"Hello AI","model":"gpt-4o-mini"}'</code></pre>

        <h2>🐍 Python Example</h2>
        <pre><code>import requests

url = "https://your-domain.vercel.app/api/chat"
headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer bhai_duck_ai_secure_token_2026"
}
payload = {"message": "Hello AI", "model": "gpt-5-mini"}

response = requests.post(url, json=payload, headers=headers)
print(response.json()["reply"])</code></pre>

        <footer>
            Built with ❤️ using Node.js + Express &mdash; Deployable on Vercel & Render<br>
            &copy; ${new Date().getFullYear()} Duck AI API Wrapper
        </footer>
    </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlDocs);
});

// 💬 MAIN CHAT API ENDPOINT (PROTECTED BY MIDDLEWARE)
app.post('/api/chat', validateApiKey, async (req, res) => {
    const { message, model } = req.body || {};

    if (!message || typeof message !== 'string') {
        return res.status(400).json({
            status: "error",
            message: "Bhai, 'message' field daalna compulsory hai aur woh string honi chahiye!"
        });
    }

    const selectedModel = model || 'gpt-4o-mini';

    // Optional: validate model against supported list
    const isValidModel = SUPPORTED_MODELS.some(m => m.id === selectedModel);
    if (!isValidModel) {
        return res.status(400).json({
            status: "error",
            message: `Model '${selectedModel}' supported nahi hai bhai!`,
            supported_models: SUPPORTED_MODELS.map(m => m.id)
        });
    }

    try {
        // Step 1: DuckDuckGo se secure VQD token nikalna
        const tokenResponse = await fetch('https://duckduckgo.com/duckchat/v1/status', {
            method: 'GET',
            headers: {
                'x-vqd-accept': '1',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        const vqdToken = tokenResponse.headers.get('x-vqd-4');

        if (!vqdToken) {
            throw new Error("DuckDuckGo se VQD handshake nahi ho paya! Token nahi mila.");
        }

        // Step 2: Selected Model ke saath chat request bhejna
        const chatResponse = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-vqd-4': vqdToken,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/event-stream',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://duckduckgo.com',
                'Referer': 'https://duckduckgo.com/'
            },
            body: JSON.stringify({
                model: selectedModel,
                messages: [{ role: 'user', content: message }]
            })
        });

        if (!chatResponse.ok) {
            const errText = await chatResponse.text();
            throw new Error(`DuckDuckGo API error: ${chatResponse.status} - ${errText.slice(0, 200)}`);
        }

        const rawText = await chatResponse.text();

        // Step 3: Stream response ko parse karke plain text banana
        const lines = rawText.split('\n');
        let fullReply = '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
                const chunkText = trimmed.slice(6).trim();
                if (chunkText === '[DONE]' || chunkText === '') continue;

                try {
                    const parsedChunk = JSON.parse(chunkText);
                    if (parsedChunk.message) {
                        fullReply += parsedChunk.message;
                    }
                } catch (e) {
                    // Ignore malformed chunks
                }
            }
        }

        return res.json({
            status: "success",
            model_used: selectedModel,
            reply: fullReply.trim()
        });

    } catch (error) {
        console.error('Chat API Error:', error);
        return res.status(500).json({
            status: "error",
            message: "Backend me koi dikkat aayi hai bhai!",
            details: error.message
        });
    }
});

// 🚫 404 HANDLER
app.use((req, res) => {
    res.status(404).json({
        status: "error",
        message: "Route nahi mila bhai! Available: GET / and POST /api/chat"
    });
});

// 🚀 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🦆 Duck AI API Server running on port ${PORT}`);
    console.log(`📄 Docs: http://localhost:${PORT}/`);
});

// Export for Vercel serverless
module.exports = app;
