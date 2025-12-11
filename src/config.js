const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Default API URL (Recall.ai)
const DEFAULT_API_URL = 'https://us-west-2.recall.ai';

// Environment definitions
const ENVIRONMENTS = {
  prod: {
    name: 'Production',
    backendUrl: 'https://api.chatsheet.com'
  },
  staging: {
    name: 'Staging',
    backendUrl: 'http://run.staging.tryecho.ai'
  },
  dev: {
    name: 'Development',
    backendUrl: 'https://run.dev.tryecho.ai'
  },
  custom: {
    name: 'Custom',
    backendUrl: null // Will be stored separately
  }
};

// Default environment
const DEFAULT_ENVIRONMENT = 'dev';
const DEFAULT_URL = ENVIRONMENTS[DEFAULT_ENVIRONMENT].backendUrl;

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
      
      // Handle migration from old config format (without environment)
      let environment = config.environment || DEFAULT_ENVIRONMENT;
      let customBackendUrl = config.customBackendUrl || null;
      
      // If old format has backendUrl but no environment, try to match it
      if (config.backendUrl && !config.environment) {
        const foundEnv = Object.keys(ENVIRONMENTS).find(env => 
          ENVIRONMENTS[env].backendUrl === config.backendUrl
        );
        if (foundEnv) {
          environment = foundEnv;
        } else {
          // If it doesn't match any environment, set as custom
          environment = 'custom';
          customBackendUrl = config.backendUrl;
        }
      }
      
      return {
        sessionToken: config.sessionToken || null,
        environment: environment,
        customBackendUrl: customBackendUrl
      };
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return {
    sessionToken: null,
    environment: DEFAULT_ENVIRONMENT,
    customBackendUrl: null
  };
};

// Get backend URL for a specific environment
const getBackendUrlForEnvironment = (environment, customBackendUrl = null) => {
  if (environment === 'custom') {
    return customBackendUrl || DEFAULT_URL;
  }
  const env = ENVIRONMENTS[environment];
  return env ? env.backendUrl : DEFAULT_URL;
};

// Save configuration to file
const saveConfig = (sessionToken, environment = null, customBackendUrl = null) => {
  try {
    const configPath = getConfigPath();
    const currentConfig = loadConfig();
    
    // Preserve existing values if not provided
    const finalEnvironment = environment !== null ? environment : (currentConfig.environment || DEFAULT_ENVIRONMENT);
    const finalCustomBackendUrl = customBackendUrl !== null ? customBackendUrl : currentConfig.customBackendUrl;
    
    const config = {
      sessionToken: sessionToken,
      environment: finalEnvironment,
      customBackendUrl: finalCustomBackendUrl
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving config:', error);
    return false;
  }
};

// Save environment configuration
const saveEnvironment = (environment, customBackendUrl = null) => {
  try {
    const configPath = getConfigPath();
    const currentConfig = loadConfig();
    
    const config = {
      sessionToken: currentConfig.sessionToken,
      environment: environment,
      customBackendUrl: customBackendUrl
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving environment config:', error);
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

// Get current environment
const getEnvironment = () => {
  const config = loadConfig();
  return config.environment || DEFAULT_ENVIRONMENT;
};

// Get backend URL (for authentication and SDK upload proxy)
// Computed from environment and customBackendUrl - not stored in config
const getBackendUrl = () => {
  const config = loadConfig();
  return getBackendUrlForEnvironment(config.environment || DEFAULT_ENVIRONMENT, config.customBackendUrl);
};

module.exports = {
  loadConfig,
  saveConfig,
  saveEnvironment,
  isConfigured,
  getSessionToken,
  getEnvironment,
  getBackendUrl,
  getBackendUrlForEnvironment,
  ENVIRONMENTS,
  DEFAULT_API_URL,
  DEFAULT_URL,
  DEFAULT_ENVIRONMENT
};

