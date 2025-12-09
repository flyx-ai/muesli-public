const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Default API URL
const DEFAULT_API_URL = 'https://us-west-2.recall.ai';

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
        apiKey: config.apiKey || null,
        apiUrl: config.apiUrl || DEFAULT_API_URL
      };
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return {
    apiKey: null,
    apiUrl: DEFAULT_API_URL
  };
};

// Save configuration to file
const saveConfig = (apiKey, apiUrl = DEFAULT_API_URL) => {
  try {
    const configPath = getConfigPath();
    const config = {
      apiKey: apiKey,
      apiUrl: apiUrl || DEFAULT_API_URL
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving config:', error);
    return false;
  }
};

// Check if API key is configured
const isConfigured = () => {
  const config = loadConfig();
  return config.apiKey !== null && config.apiKey.trim() !== '';
};

// Get API key
const getApiKey = () => {
  const config = loadConfig();
  return config.apiKey;
};

// Get API URL
const getApiUrl = () => {
  const config = loadConfig();
  return config.apiUrl || DEFAULT_API_URL;
};

module.exports = {
  loadConfig,
  saveConfig,
  isConfigured,
  getApiKey,
  getApiUrl,
  DEFAULT_API_URL
};

