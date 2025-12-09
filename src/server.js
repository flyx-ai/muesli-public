const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');
const fs = require('fs');
const os = require('os');

// Helper function to get config path (works without electron)
const getConfigPath = () => {
  const platform = process.platform;
  let userDataPath;
  
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
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      return {
        apiKey: config.apiKey || null,
        apiUrl: config.apiUrl || 'https://us-west-2.recall.ai'
      };
    }
  } catch (error) {
    console.error('Error loading config:', error);
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
    reloadConfig();
    
    if (!RECALLAI_API_KEY) {
        console.error("RECALLAI_API_KEY is missing! Please configure it in the app settings.");
        return res.json({ status: 'error', message: 'RECALLAI_API_KEY is missing. Please configure it in the app settings.' });
    }
    
    console.log(`Creating upload token with API key: ${RECALLAI_API_KEY.slice(0,4)}...`);

    const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;

    try {
        const response = await axios.post(url, {
            recording_config: {
                transcript: {
                    provider: {
                        assembly_ai_v3_streaming: {}
                    }
                },
                realtime_endpoints: [
                    {
                        type: "desktop_sdk_callback",
                        events: [
                            "participant_events.join",
                            "video_separate_png.data",
                            "transcript.data",
                            "transcript.provider_data"
                        ]
                    },
                ],
            }
        }, {
            headers: { 'Authorization': `Token ${RECALLAI_API_KEY}` },
            timeout: 9000,
        });

        res.json({ status: 'success', upload_token: response.data.upload_token });
    } catch (e) {
        console.error("Error creating upload token:", e.errors || e.response?.data || e.message);
        res.json({ status: 'error', message: e.message });
    }
});

if (require.main === module) {
    app.listen(13373, () => {
        console.log(`Server listening on http://localhost:13373`);
    });
}

module.exports = app;
