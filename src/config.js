const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Default API URL (Recall.ai)
const DEFAULT_API_URL = 'https://us-west-2.recall.ai';
// Default backend URL (for authentication and SDK upload proxy)
// const DEFAULT_URL = 'https://advantages-str-screensavers-adjustments.trycloudflare.com';
const DEFAULT_URL = 'https://run.dev.tryecho.ai/';

// Path to config file in user data directory
const getConfigPath = () => {
  return path.join(app.getPath('userData'), 'config.json');
};

// Load configuration from file
const loadConfig = () => {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      return {
        sessionToken: config.sessionToken || null,
        backendUrl: config.backendUrl || DEFAULT_URL
      };
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return {
    sessionToken: null,
    backendUrl: DEFAULT_URL
  };
};

// Save configuration to file
const saveConfig = (sessionToken, backendUrl = DEFAULT_URL) => {
  try {
    const configPath = getConfigPath();
    const config = {
      sessionToken: sessionToken,
      backendUrl: backendUrl || DEFAULT_URL
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving config:', error);
    return false;
  }
};

// Check if session token is configured
const isConfigured = () => {
  const config = loadConfig();
  return config.sessionToken !== null && config.sessionToken.trim() !== '';
};

// Get session token
const getSessionToken = () => {
  const config = loadConfig();
  return config.sessionToken;
};

// Get backend URL (for authentication and SDK upload proxy)
const getBackendUrl = () => {
  const config = loadConfig();
  return config.backendUrl || DEFAULT_URL;
};

module.exports = {
  loadConfig,
  saveConfig,
  isConfigured,
  getSessionToken,
  getBackendUrl,
  DEFAULT_API_URL,
  DEFAULT_URL
};

