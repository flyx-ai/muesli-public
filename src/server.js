const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');
const fs = require('fs');
const os = require('os');

// Helper function to get config path (works without electron)
// Note: This must match the directory name used by Electron's app.getPath('userData')
// On Windows, Electron uses the app name with proper casing (e.g., "Muesli")
const getConfigPath = () => {
  const platform = process.platform;
  let userDataPath;
  console.log(`[Server] Platform: ${platform}`);
  console.log(`[Server] Home directory: ${os.homedir()}`);

  if (platform === 'darwin') {
    userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'muesli');
  } else if (platform === 'win32') {
    userDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'muesli');
  } else {
    userDataPath = path.join(os.homedir(), '.config', 'muesli');
  }
  
  // Ensure directory exists
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }
  
  return path.join(userDataPath, 'config.json');
};

// Load configuration from file
const loadConfig = () => {
  try {
    const configPath = getConfigPath();
    console.log(`[Server] Attempting to load config from: ${configPath}`);
    const fileExists = fs.existsSync(configPath);
    console.log(`[Server] Config file exists: ${fileExists}`);
    
    if (fileExists) {
      const configData = fs.readFileSync(configPath, 'utf8');
      console.log(`[Server] Config file content length: ${configData.length} bytes`);
      const config = JSON.parse(configData);
      const hasApiKey = !!(config.apiKey && config.apiKey.trim() !== '');
      console.log(`[Server] Config parsed successfully. API Key present: ${hasApiKey}`);
      if (hasApiKey) {
        console.log(`[Server] API Key (first 8 chars): ${config.apiKey.substring(0, 8)}...`);
      }
      return {
        apiKey: config.apiKey || null,
        apiUrl: config.apiUrl || 'https://us-west-2.recall.ai'
      };
    } else {
      console.error(`[Server] Config file not found at: ${configPath}`);
      // Try to list the directory to see what's there
      const dirPath = path.dirname(configPath);
      if (fs.existsSync(dirPath)) {
        console.log(`[Server] Directory exists. Contents:`, fs.readdirSync(dirPath));
      } else {
        console.log(`[Server] Directory does not exist: ${dirPath}`);
      }
    }
  } catch (error) {
    console.error('[Server] Error loading config:', error);
    console.error('[Server] Error stack:', error.stack);
  }
  return {
    apiKey: null,
    apiUrl: 'https://us-west-2.recall.ai'
  };
};

// API configuration for Recall.ai
let config = loadConfig();
let RECALLAI_API_URL = config.apiUrl;
let RECALLAI_API_KEY = config.apiKey;

// Function to reload config (useful if config changes)
const reloadConfig = () => {
  config = loadConfig();
  RECALLAI_API_URL = config.apiUrl;
  RECALLAI_API_KEY = config.apiKey;
};

app.get('/start-recording', async (req, res) => {
    // Reload config in case it was updated
    console.log(`[Server] /start-recording endpoint called`);
    reloadConfig();
    
    // Log config path for debugging
    console.log(`[Server] After reload - API Key loaded: ${RECALLAI_API_KEY ? RECALLAI_API_KEY.substring(0, 8) + '...' : 'null'}`);
    
    if (!RECALLAI_API_KEY) {
        console.error("[Server] RECALLAI_API_KEY is missing! Please configure it in the app settings.");
        return res.json({ status: 'error', message: 'RECALLAI_API_KEY is missing. Please configure it in the app settings.' });
    }
    
    console.log(`[Server] Creating upload token with API key: ${RECALLAI_API_KEY.slice(0,4)}...`);

    const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;
    console.log(`[Server] Request URL: ${url}`);

    const requestBody = {
        recording_config: {
            // transcript: {
            //     provider: {
            //         recallai_streaming: {}
            //     }
            // },
            realtime_endpoints: [
                {
                    type: "desktop_sdk_callback",
                    events: [
                        "transcript.data",
                    ]
                },
            ],
        }
    };

    console.log(`[Server] Request body:`, JSON.stringify(requestBody, null, 2));

    try {
        const response = await axios.post(url, requestBody, {
            headers: { 
                'accept': 'application/json',
                'content-type': 'application/json',
                'Authorization': RECALLAI_API_KEY
            },
            timeout: 9000,
        });
        
        console.log(`[Server] Response status: ${response.status}`);
        console.log(`[Server] Response data:`, JSON.stringify(response.data, null, 2));

        console.log(`[Server] Upload token created successfully`);
        res.json({ status: 'success', upload_token: response.data.upload_token });
    } catch (e) {
        console.error("[Server] Error creating upload token:", e.message);
        if (e.response) {
            console.error("[Server] Response status:", e.response.status);
            console.error("[Server] Response data:", JSON.stringify(e.response.data, null, 2));
        }
        res.json({ status: 'error', message: e.message || 'Failed to create upload token' });
    }
});

if (require.main === module) {
    // Log initial config load on server startup
    console.log(`[Server] Starting server...`);
    const initialConfig = loadConfig();
    console.log(`[Server] Initial config load - API Key: ${initialConfig.apiKey ? initialConfig.apiKey.substring(0, 8) + '...' : 'null'}`);
    console.log(`[Server] Config path: ${getConfigPath()}`);
    
    app.listen(13373, () => {
        console.log(`[Server] Server listening on http://localhost:13373`);
    });
}

module.exports = app;
