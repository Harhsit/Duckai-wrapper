const express = require('express');
const cors = require('cors');

const app = express();

// 🌐 FULLY OPEN CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '10mb' }));

// 🔑 API KEY SETUP
const API_KEY = process.env.DUCK_AI_API_KEY || "bhai_duck_ai_secure_token_2026";

// 🤖 SUPPORTED MODELS LIST
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

    if (authHeader && authHeader.startsWith('Bearer ')) {
        userKey = authHeader.split(' ')[1].trim();
    } else if (customKeyHeader) {
        userKey = String(customKeyHeader).trim();
    }

    if (!userKey || userKey !== API_KEY) {
        return res.status(401).json({
            status: "error",
            message: "Unauthorized! Bhai galat ya missing API Key hai."
        });
    }
    next();
};

// 📄 HOME ROUTE - DOCUMENTATION
app.get('/', (req, res) => {
    res.send("<h1>🦆 Duck AI Gateway is Live bhai!</h1><p>Use POST /api/chat to connect.</p>");
});

// 💬 MAIN CHAT API ENDPOINT (WITH VQD FALLBACK BYPASS)
app.post('/api/chat', validateApiKey, async (req, res) => {
    const { message, model } = req.body || {};

    if (!message || typeof message !== 'string') {
        return res.status(400).json({
            status: "error",
            message: "Bhai, 'message' field daalna compulsory hai!"
        });
    }

    const selectedModel = model || 'gpt-4o-mini';
    let vqdToken = null;

    try {
        // 🔥 METHOD 1: Standard API Status Handshake
        try {
            const tokenResponse = await fetch('https://duckduckgo.com/duckchat/v1/status', {
                method: 'GET',
                headers: {
                    'x-vqd-accept': '1',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                }
            });
            vqdToken = tokenResponse.headers.get('x-vqd-4');
        } catch (e) {
            console.log("Method 1 failed, switching to smart bypass...");
        }

        // 🛡️ METHOD 2 BYPASS: Agar pehla tareeka block hua, toh main HTML se token nikalenge
        if (!vqdToken) {
            const bypassResponse = await fetch('https://duckduckgo.com/?q=how+to+code+an+api', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                }
            });
            const htmlText = await bypassResponse.text();
            
            // HTML ke andar se vqd='...' nikalne ke liye dynamic regex match
            const vqdMatch = htmlText.match(/vqd=["']([^"']+)["']/);
            if (vqdMatch && vqdMatch[1]) {
                vqdToken = vqdMatch[1];
                console.log("Bypass Successful! Found VQD Token via HTML Parsing.");
            }
        }

        // Agar dono tareeqe fail ho gaye tabhi error denge
        if (!vqdToken) {
            throw new Error("DuckDuckGo ne dono tareeqon ko block kar diya bhai! IP Rate limit issue.");
        }

        // Step 2: Chat Request with valid Token
        const chatResponse = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-vqd-4': vqdToken,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/event-stream',
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
            throw new Error(`DuckDuckGo Chat Error: ${chatResponse.status} - ${errText.slice(0, 100)}`);
        }

        const rawText = await chatResponse.text();
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
                } catch (e) {}
            }
        }

        return res.json({
            status: "success",
            model_used: selectedModel,
            reply: fullReply.trim()
        });

    } catch (error) {
        console.error('Final API Error:', error);
        return res.status(500).json({
            status: "error",
            message: "Backend me dikkat aayi hai bhai!",
            details: error.message
        });
    }
});

app.use((req, res) => {
    res.status(404).json({ status: "error", message: "Route nahi mila!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
