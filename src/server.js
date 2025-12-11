const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');
const fs = require('fs');
const os = require('os');

// Middleware to parse JSON request bodies
app.use(express.json());

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
      const sessionToken = config.sessionToken || null;
      const hasSessionToken = !!(sessionToken && sessionToken.trim() !== '');
      console.log(`[Server] Config parsed successfully. Session Token present: ${hasSessionToken}`);
      if (hasSessionToken) {
        console.log(`[Server] Session Token (first 8 chars): ${sessionToken.substring(0, 8)}...`);
      }
      return {
        sessionToken: config.sessionToken || null,
        backendUrl: config.backendUrl || 'https://api.chatsheet.com'
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
    sessionToken: null,
    backendUrl: 'https://api.chatsheet.com'
  };
};

// API configuration
let config = loadConfig();
let SESSION_TOKEN = config.sessionToken;
let BACKEND_URL = config.backendUrl || 'https://api.chatsheet.com';

// Function to reload config (useful if config changes)
const reloadConfig = () => {
  config = loadConfig();
  SESSION_TOKEN = config.sessionToken;
  BACKEND_URL = config.backendUrl || 'https://api.chatsheet.com';
};

app.post('/start-recording', async (req, res) => {
    // Reload config in case it was updated
    console.log(`[Server] /start-recording endpoint called`);
    reloadConfig();
    
    // Log config path for debugging
    console.log(`[Server] After reload - Session Token loaded: ${SESSION_TOKEN ? SESSION_TOKEN.substring(0, 8) + '...' : 'null'}`);
    
    if (!SESSION_TOKEN) {
        console.error("[Server] SESSION_TOKEN is missing! Please log in through the app.");
        return res.json({ status: 'error', message: 'Session token is missing. Please log in through the app.' });
    }
    
    // Get meeting_url from request body
    const meetingUrl = req.body.meeting_url;
    
    if (!meetingUrl) {
        console.error("[Server] meeting_url is required in request body");
        return res.json({ status: 'error', message: 'meeting_url is required' });
    }
    
    console.log(`[Server] Creating upload token via backend service for meeting: ${meetingUrl}`);

    // Call backend service - new endpoint format
    const backendUrl = `${BACKEND_URL}/api/v1/integrations/recall/sdk`;
    console.log(`[Server] Backend URL: ${backendUrl}`);

    // Build request body with recording_config for real-time transcription
    // According to Recall.ai docs, we need to configure:
    // 1. transcript provider (e.g., assembly_ai_v3_streaming)
    // 2. realtime_endpoints with type 'desktop_sdk_callback' and events like 'transcript.data'
    const requestBody = {
        meeting_url: meetingUrl,
        recording_config: {
            transcript: {
                provider: {
                    // Use Recall.ai's built-in transcription (no API key needed)
                    // Alternative: assembly_ai_v3_streaming, deepgram_v2, etc.
                    // recallai_streaming: {}
                    assembly_ai_v3_streaming: {}
                }
            },
            realtime_endpoints: [
                {
                    type: 'desktop_sdk_callback',
                    events: [
                        'transcript.data',              // Real-time transcript data
                        'transcript.provider_data',     // Raw provider data (for speaker detection)
                        'participant_events.join'      // Participant join events
                    ]
                }
            ]
        }
    };

    console.log(`[Server] Request body:`, JSON.stringify(requestBody, null, 2));

    try {
        // Use session token in Cookie header for authentication
        const response = await axios.post(backendUrl, requestBody, {
            headers: { 
                'accept': 'application/json',
                'content-type': 'application/json',
                'Cookie': `szrch_session_token=${SESSION_TOKEN}`
            },
            timeout: 9000,
        });
        
        console.log(`[Server] Response status: ${response.status}`);
        console.log(`[Server] Response data:`, JSON.stringify(response.data, null, 2));

        console.log(`[Server] Upload token created successfully`);
        // Return the full response structure
        // Note: response.data.status is an object from the backend, so we use 'success' as a wrapper status
        res.json({ 
            status: 'success', 
            upload_token: response.data.upload_token,
            id: response.data.id,
            recording_id: response.data.recording_id,
            status_detail: response.data.status, // Rename to avoid overwriting our 'success' status
            created_at: response.data.created_at,
            metadata: response.data.metadata
        });
    } catch (e) {
        console.error("[Server] Error creating upload token:", e.message);
        let errorMessage = 'Failed to create upload token';
        
        if (e.response) {
            console.error("[Server] Response status:", e.response.status);
            console.error("[Server] Response data:", JSON.stringify(e.response.data, null, 2));
            
            // Try to extract a more meaningful error message from the response
            if (e.response.data) {
                if (e.response.data.message) {
                    errorMessage = e.response.data.message;
                } else if (e.response.data.error) {
                    errorMessage = typeof e.response.data.error === 'string' 
                        ? e.response.data.error 
                        : e.response.data.error.message || errorMessage;
                } else if (e.response.status === 500) {
                    errorMessage = 'Server error: Please try again or contact support';
                } else if (e.response.status === 401 || e.response.status === 403) {
                    errorMessage = 'Authentication failed: Please log in again';
                } else {
                    errorMessage = `Request failed with status code ${e.response.status}`;
                }
            } else {
                errorMessage = `Request failed with status code ${e.response.status}`;
            }
        } else if (e.message) {
            errorMessage = e.message;
        }
        
        res.json({ status: 'error', message: errorMessage });
    }
});

if (require.main === module) {
    // Log initial config load on server startup
    console.log(`[Server] Starting server...`);
    const initialConfig = loadConfig();
    console.log(`[Server] Initial config load - Session Token: ${initialConfig.sessionToken ? initialConfig.sessionToken.substring(0, 8) + '...' : 'null'}`);
    console.log(`[Server] Backend URL: ${initialConfig.backendUrl || 'https://api.chatsheet.com'}`);
    console.log(`[Server] Config path: ${getConfigPath()}`);
    
    app.listen(13373, () => {
        console.log(`[Server] Server listening on http://localhost:13373`);
    });
}

module.exports = app;
