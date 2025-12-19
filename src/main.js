const { app, BrowserWindow, ipcMain, protocol, Notification, shell, dialog } = require('electron');
const path = require('node:path');
const url = require('url');
const fs = require('fs');
const RecallAiSdk = require('@recallai/desktop-sdk');
const axios = require('axios');
const OpenAI = require('openai');
const sdkLogger = require('./sdk-logger');
const config = require('./config');

// Function to get the OpenRouter headers
function getHeaderLines() {
  return [
    "HTTP-Referer: https://recall.ai", // Replace with your actual app's URL
    "X-Title: Muesli AI Notetaker"
  ];
}

// Initialize OpenAI client with OpenRouter as the base URL
// Note: OpenRouter key is optional, so we'll initialize it even if not set
// Check for API key in environment variable (OPENAI_API_KEY or OPENROUTER_API_KEY)
const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || null;
let openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: apiKey, // Will be set from environment variable if available
  defaultHeaders: {
    "HTTP-Referer": "https://recall.ai",
    "X-Title": "Muesli AI Notetaker"
  }
});

// Define available models with their capabilities
const MODELS = {
  // Primary models
  PRIMARY: "anthropic/claude-3.7-sonnet",
  FALLBACKS: []
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Store detected meeting information
let detectedMeeting = null;

let mainWindow;
let configWindow = null;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f9f9f9',
  });

  // Allow the debug panel header to act as a drag region
  mainWindow.on('ready-to-show', () => {
    try {
      // Set regions that can be used to drag the window
      if (process.platform === 'darwin') {
        // Only needed on macOS
        mainWindow.setWindowButtonVisibility(true);
      }
    } catch (error) {
      console.error('Error setting drag regions:', error);
    }
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools in development
  if (process.env.NODE_ENV === 'development') {
    // mainWindow.webContents.openDevTools();
  }

  // Listen for navigation events
  ipcMain.on('navigate', (event, page) => {
    if (page === 'note-editor') {
      mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY + '/../note-editor/index.html');
    } else if (page === 'home') {
      mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
    }
  });
};

// Create configuration dialog window
const createConfigWindow = () => {
  configWindow = new BrowserWindow({
    width: 600,
    height: 500,
    resizable: false,
    modal: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f9f9f9',
  });

  // Load the config dialog HTML - try multiple possible paths
  const possiblePaths = [
    path.join(__dirname, 'config-dialog.html'),
    path.join(__dirname, '..', 'src', 'config-dialog.html'),
    path.join(app.getAppPath(), 'src', 'config-dialog.html'),
  ];
  
  let htmlPath = null;
  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      htmlPath = possiblePath;
      break;
    }
  }
  
  if (htmlPath) {
    configWindow.loadFile(htmlPath);
  } else {
    console.error('Config dialog HTML not found. Tried paths:', possiblePaths);
    // Fallback: create a simple HTML content
    configWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>Login</title></head>
      <body style="font-family: sans-serif; padding: 40px;">
        <h1>Welcome to Muesli</h1>
        <p>Please log in to get started.</p>
        <button onclick="openLogin()" style="padding: 10px 20px; background: #6947BD; color: white; border: none; cursor: pointer;">Log In</button>
        <script>
          const { ipcRenderer } = require('electron');
          async function openLogin() {
            await ipcRenderer.invoke('open-login');
          }
          ipcRenderer.on('login-success', () => {
            ipcRenderer.send('config-saved');
          });
        </script>
      </body>
      </html>
    `));
  }

  configWindow.once('ready-to-show', () => {
    configWindow.show();
  });

  configWindow.on('closed', () => {
    configWindow = null;
  });

  return configWindow;
};

// Request single instance lock FIRST (before protocol registration)
// This ensures only one instance of the app runs at a time
// When a second instance tries to launch, it will trigger 'second-instance' event
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
  process.exit(0);
}

// Register deep link protocol handler
// This must be called before app.whenReady() on Windows
if (process.defaultApp) {
  // Development mode - register with full path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('chatsheet-recall', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient('chatsheet-recall');
}

// Handle deep link when app is already running (macOS)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Handle second instance (when app is already running and receives a deep link)
app.on('second-instance', (event, commandLine, workingDirectory) => {
  // Find the protocol URL in command line arguments
  const protocolUrl = commandLine.find(arg => arg && arg.startsWith('chatsheet-recall://'));
  if (protocolUrl) {
    handleDeepLink(protocolUrl);
  }
  
  // Focus the existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Handle deep link when app is launched via protocol (Windows/Linux)
// Check command line arguments for protocol URL (only on first launch)
if (process.platform === 'win32' || process.platform === 'linux') {
  const protocolUrl = process.argv.find(arg => arg && arg.startsWith('chatsheet-recall://'));
  if (protocolUrl) {
    // Store it to handle after app is ready
    // We'll handle it in app.whenReady() to ensure config is loaded
    process.deepLinkUrl = protocolUrl;
  }
}

// Function to handle deep link callbacks
function handleDeepLink(urlString) {
  try {
    console.log('Received deep link:', urlString);
    const urlObj = new URL(urlString);
    
    if (urlObj.protocol === 'chatsheet-recall:' && urlObj.hostname === 'login') {
      const token = urlObj.searchParams.get('token');
      if (token) {
        console.log('Received session token from deep link');
        // Save the session token (preserve current environment)
        const currentConfig = config.loadConfig();
        config.saveConfig(token, currentConfig.environment, currentConfig.customBackendUrl);
        
        // Notify config window if it's open
        if (configWindow && !configWindow.isDestroyed()) {
          configWindow.webContents.send('login-success');
        }
        
        // Notify main window if login view is shown
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('login-success');
        }
        
        // If app is already initialized, we might need to restart or reload
        // For now, just log that login was successful
        console.log('Session token saved successfully');
      } else {
        console.error('No token found in deep link');
        if (configWindow && !configWindow.isDestroyed()) {
          configWindow.webContents.send('login-error', 'No token received from login');
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('login-error', 'No token received from login');
        }
      }
    }
  } catch (error) {
    console.error('Error handling deep link:', error);
    if (configWindow && !configWindow.isDestroyed()) {
      configWindow.webContents.send('login-error', error.message);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-error', error.message);
    }
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Handle deep link if app was launched via protocol (Windows/Linux)
  if (process.deepLinkUrl) {
    handleDeepLink(process.deepLinkUrl);
    delete process.deepLinkUrl;
  }
  
  // Check if session token is configured
  if (!config.isConfigured()) {
    console.log("Session token not configured, showing login view");
    // Create main window first, then show login view
    createWindow();
    // Send event to show login view in main window after it loads
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('show-login-view');
      });
    }
    return; // Don't proceed until config is saved
  }

  // Session token is already configured
  const sessionToken = config.getSessionToken();
  const apiUrl = config.DEFAULT_API_URL; // Use default API URL directly
  console.log("Session token already configured");
  console.log(`Using API URL: ${apiUrl}`);
  console.log(`Session Token: ${sessionToken ? sessionToken.substring(0, 8) + '...' : 'not set'}`);

  // Initialize app with configured session token
  initializeApp();
});

// Initialize the app after configuration is complete
function initializeApp() {
  console.log("Registering IPC handlers...");
  // Log all registered IPC handlers
  console.log("IPC handlers:", Object.keys(ipcMain._invokeHandlers));
  
  // Load configuration
  const sessionToken = config.getSessionToken();
  const apiUrl = config.DEFAULT_API_URL; // Use default API URL directly
  console.log(`Using API URL: ${apiUrl}`);

  // Set up SDK logger IPC handlers
  ipcMain.on('sdk-log', (event, logEntry) => {
    // Forward logs from renderer to any open windows
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-log', logEntry);
    }
  });

  // Set up logger event listener to send logs from main to renderer
  sdkLogger.onLog((logEntry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-log', logEntry);
    }
  });

  // Create recordings directory if it doesn't exist
  try {
    if (!fs.existsSync(RECORDING_PATH)) {
      fs.mkdirSync(RECORDING_PATH, { recursive: true });
    }
  } catch (e) {
    console.error("Couldn't create the recording path:", e);
  }

  // Create meetings file if it doesn't exist
  try {
    if (!fs.existsSync(meetingsFilePath)) {
      const initialData = { upcomingMeetings: [], pastMeetings: [] };
      fs.writeFileSync(meetingsFilePath, JSON.stringify(initialData, null, 2));
    }
  } catch (e) {
    console.error("Couldn't create the meetings file:", e);
  }

  // Initialize the Recall.ai SDK (only on supported platforms)
  initSDK(apiUrl);

  createWindow();

  // When the window is ready, send the initial meeting detection status
  mainWindow.webContents.on('did-finish-load', () => {
    // Send the initial meeting detection status
    mainWindow.webContents.send('meeting-detection-status', { detected: detectedMeeting !== null });
  });

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

// Path to meetings data file in the user's Application Support directory
const meetingsFilePath = path.join(app.getPath('userData'), 'meetings.json');

// Path for RecallAI SDK recordings
const RECORDING_PATH = path.join(app.getPath("userData"), 'recordings');

// Global state to track active recordings
const activeRecordings = {
  // Map of recordingId -> {noteId, platform, state}
  recordings: {},

  // Register a new recording
  addRecording: function (recordingId, noteId, platform = 'unknown') {
    this.recordings[recordingId] = {
      noteId,
      platform,
      state: 'recording',
      startTime: new Date()
    };
    console.log(`Recording registered in global state: ${recordingId} for note ${noteId}`);
  },

  // Update a recording's state
  updateState: function (recordingId, state) {
    if (this.recordings[recordingId]) {
      this.recordings[recordingId].state = state;
      console.log(`Recording ${recordingId} state updated to: ${state}`);
      return true;
    }
    return false;
  },

  // Remove a recording
  removeRecording: function (recordingId) {
    if (this.recordings[recordingId]) {
      delete this.recordings[recordingId];
      console.log(`Recording ${recordingId} removed from global state`);
      return true;
    }
    return false;
  },

  // Get active recording for a note
  getForNote: function (noteId) {
    for (const [recordingId, info] of Object.entries(this.recordings)) {
      if (info.noteId === noteId) {
        return { recordingId, ...info };
      }
    }
    return null;
  },

  // Get all active recordings
  getAll: function () {
    return { ...this.recordings };
  }
};

// File operation manager to prevent race conditions on both reads and writes
const fileOperationManager = {
  isProcessing: false,
  pendingOperations: [],
  cachedData: null,
  lastReadTime: 0,

  // Read the meetings data with caching to reduce file I/O
  readMeetingsData: async function () {
    // If we have cached data that's recent (less than 500ms old), use it
    const now = Date.now();
    if (this.cachedData && (now - this.lastReadTime < 500)) {
      return JSON.parse(JSON.stringify(this.cachedData)); // Deep clone
    }

    try {
      // Read from file
      const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      const data = JSON.parse(fileData);

      // Update cache
      this.cachedData = data;
      this.lastReadTime = now;

      return data;
    } catch (error) {
      // If file doesn't exist (ENOENT), create it with empty structure and return it
      if (error.code === 'ENOENT') {
        const emptyData = { upcomingMeetings: [], pastMeetings: [] };
        try {
          // Ensure the directory exists
          const dir = path.dirname(meetingsFilePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          // Create the file with empty data
          await fs.promises.writeFile(meetingsFilePath, JSON.stringify(emptyData, null, 2));
          // Update cache
          this.cachedData = emptyData;
          this.lastReadTime = now;
        } catch (writeError) {
          // If we can't create the file, just return empty structure
          console.error('Error creating meetings file:', writeError);
        }
        return emptyData;
      }
      
      // For other errors (permission issues, invalid JSON, etc.), log and return empty structure
      console.error('Error reading meetings data:', error);
      return { upcomingMeetings: [], pastMeetings: [] };
    }
  },

  // Schedule an operation that needs to update the meetings data
  scheduleOperation: async function (operationFn) {
    return new Promise((resolve, reject) => {
      // Add this operation to the queue
      this.pendingOperations.push({
        operationFn, // This function will receive the current data and return updated data
        resolve,
        reject
      });

      // Process the queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  },

  // Process the operation queue sequentially
  processQueue: async function () {
    if (this.pendingOperations.length === 0 || this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // Get the next operation
      const nextOp = this.pendingOperations.shift();

      // Read the latest data
      const currentData = await this.readMeetingsData();

      try {
        // Execute the operation function with the current data
        const updatedData = await nextOp.operationFn(currentData);

        // If the operation returned data, write it
        if (updatedData) {
          // Update cache immediately
          this.cachedData = updatedData;
          this.lastReadTime = Date.now();

          // Write to file
          await fs.promises.writeFile(meetingsFilePath, JSON.stringify(updatedData, null, 2));
        }

        // Resolve the operation's promise
        nextOp.resolve({ success: true });
      } catch (opError) {
        console.error('Error in file operation:', opError);
        nextOp.reject(opError);
      }
    } catch (error) {
      console.error('Error in file operation manager:', error);

      // If there was an operation that failed, reject its promise
      if (this.pendingOperations.length > 0) {
        const failedOp = this.pendingOperations.shift();
        failedOp.reject(error);
      }
    } finally {
      this.isProcessing = false;

      // Check if more operations were added while we were processing
      if (this.pendingOperations.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  },

  // Helper to write data directly - internally uses scheduleOperation
  writeData: async function (data) {
    return this.scheduleOperation(() => data); // Simply return the data to write
  }
};

// Create a desktop SDK upload token
// meetingUrl: The meeting URL (e.g., "https://meet.google.com/kpy-twki-tuo")
async function createDesktopSdkUpload(meetingUrl) {
  try {
    console.log("[Main] Requesting upload token from server for meeting:", meetingUrl);
    
    if (!meetingUrl) {
      console.warn("[Main] No meeting URL provided, using empty string");
      meetingUrl = '';
    }
    
    const response = await axios.post("http://localhost:13373/start-recording", 
      { meeting_url: meetingUrl }, 
      { timeout: 10000 }
    );
    
    console.log('Response:', response.data);

    // Check if we have an upload_token (success) or an error status
    // The backend returns status as an object with code, or a string 'error'
    if (response.data.status === 'error' || !response.data.upload_token) {
      const errorMessage = response.data.message || 'Failed to create upload token';
      console.error("[Main] Failed to create upload token:", errorMessage);
      
      // Show error notification to user
      try {
        let notification = new Notification({
          title: 'Recording Error',
          body: `Failed to start recording: ${errorMessage}`,
          urgency: 'critical' // Make it more prominent
        });
        notification.show();
        console.log("[Main] Error notification shown to user");
        
        // Also show a dialog to ensure user sees it
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Recording Error',
            message: 'Failed to start recording',
            detail: errorMessage,
            buttons: ['OK']
          }).catch(err => {
            console.error("[Main] Failed to show error dialog:", err);
          });
        }
      } catch (notifError) {
        console.error("[Main] Failed to show error notification:", notifError);
        // Fallback: show dialog if notification fails
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Recording Error',
            message: 'Failed to start recording',
            detail: errorMessage,
            buttons: ['OK']
          }).catch(err => {
            console.error("[Main] Failed to show error dialog:", err);
          });
        }
      }
      
      return null;
    } else {
      console.log("[Main] Upload token created successfully");
      return response.data;
    }
  } catch (error) {
    console.error("[Main] Error creating upload token:", error.errors || error.message || error);
    
    // Extract user-friendly error message
    let errorMessage = 'Failed to create upload token';
    if (error.response) {
      console.error("[Main] Response data:", error.response.data);
      console.error("[Main] Response status:", error.response.status);
      
      // Try to extract error message from response
      if (error.response.data && error.response.data.message) {
        errorMessage = error.response.data.message;
      } else if (error.response.status === 500) {
        errorMessage = 'Server error: Please try again or contact support';
      } else if (error.response.status === 401 || error.response.status === 403) {
        errorMessage = 'Authentication failed: Please log in again';
      } else {
        errorMessage = `Request failed with status code ${error.response.status}`;
      }
    } else if (error.code === 'ECONNREFUSED') {
      console.error("[Main] Server connection refused. Is the server running on port 13373?");
      errorMessage = 'Cannot connect to server. Please ensure the app is running properly.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    // Show error notification to user
    try {
      let notification = new Notification({
        title: 'Recording Error',
        body: errorMessage,
        urgency: 'critical' // Make it more prominent
      });
      notification.show();
      console.log("[Main] Error notification shown to user (from catch block)");
      
      // Also show a dialog to ensure user sees it
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Recording Error',
          message: 'Failed to create upload token',
          detail: errorMessage,
          buttons: ['OK']
        }).catch(err => {
          console.error("[Main] Failed to show error dialog:", err);
        });
      }
    } catch (notifError) {
      console.error("[Main] Failed to show error notification:", notifError);
      // Fallback: show dialog if notification fails
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Recording Error',
          message: 'Failed to create upload token',
          detail: errorMessage,
          buttons: ['OK']
        }).catch(err => {
          console.error("[Main] Failed to show error dialog:", err);
        });
      }
    }
    
    return null;
  }
}

// Track if SDK is available (only supported on macOS and Windows)
const isSDKSupported = process.platform === 'darwin' || process.platform === 'win32';
let isSDKInitialized = false;

// Initialize the Recall.ai SDK
function initSDK(apiUrl) {
  // Check if platform is supported
  if (!isSDKSupported) {
    console.warn(`Recall.ai Desktop SDK is not supported on platform: ${process.platform}. SDK features will be disabled.`);
    console.warn('Supported platforms: macOS (darwin), Windows (win32)');
    return;
  }

  console.log("Initializing Recall.ai SDK");

  try {
    // Log the SDK initialization
    sdkLogger.logApiCall('init', {
      dev: process.env.NODE_ENV === 'development',
      api_url: apiUrl,
      config: {
        recording_path: RECORDING_PATH
      }
    });

    RecallAiSdk.init({
      // dev: true,
      api_url: apiUrl,
      config: {
        recording_path: RECORDING_PATH
      }
    });

    isSDKInitialized = true;

    // Request macOS permissions if on macOS
    if (process.platform === 'darwin') {
      console.log('Requesting macOS permissions for Desktop Recording SDK...');
      try {
        // Request the minimum required permissions for meeting detection and recording
        RecallAiSdk.requestPermission("accessibility");
        RecallAiSdk.requestPermission("microphone");
        RecallAiSdk.requestPermission("screen-capture");
        console.log('macOS permissions requested');
      } catch (permissionError) {
        console.error('Error requesting macOS permissions:', permissionError);
        // Continue anyway - permissions might already be granted or user will be prompted
      }
    }

    // Only register event listeners if SDK initialization succeeded
    setupSDKEventListeners();
  } catch (error) {
    console.error('Failed to initialize Recall.ai SDK:', error);
    console.warn('SDK features will be disabled due to initialization failure.');
    isSDKInitialized = false;
    return; // Exit early if initialization failed
  }
}

// Setup SDK event listeners (only called after successful initialization)
function setupSDKEventListeners() {
  // Listen for meeting detected events
  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    console.log("Meeting detected:", evt);

    // Log the meeting detected event
    sdkLogger.logEvent('meeting-detected', {
      platform: evt.window.platform,
      windowId: evt.window.id
    });

    detectedMeeting = evt;

    // Map platform codes to readable names
    const platformNames = {
      'zoom': 'Zoom',
      'google-meet': 'Google Meet',
      'slack': 'Slack',
      'teams': 'Microsoft Teams'
    };

    // Get a user-friendly platform name, or use the raw platform name if not in our map
    const platformName = platformNames[evt.window.platform] || evt.window.platform;

    // Send a notification
    let notification = new Notification({
      title: `${platformName} Meeting Detected`,
      body: platformName
    });

    // Handle notification click
    notification.on('click', () => {
      console.log("Notification clicked for platform:", platformName);
      joinDetectedMeeting();
    });

    notification.show();

    // Send the meeting detected status to the renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-detection-status', { detected: true });
    }
  });

  // Listen for meeting updated events (to capture title and URL)
  // NOTE: meeting-detected events do NOT guarantee title and URL will be populated.
  // The meeting title and URL are only reliably available in meeting-updated events,
  // which fire as the meeting metadata becomes available after initial detection.
  RecallAiSdk.addEventListener('meeting-updated', async (evt) => {
    console.log("Meeting updated:", evt);

    const { window } = evt;

    // Log the meeting updated event with the URL for tracking purposes
    sdkLogger.logEvent('meeting-updated', {
      platform: window.platform,
      windowId: window.id,
      title: window.title,
      url: window.url
    });

    // Update the detectedMeeting object with the new information
    if (detectedMeeting && detectedMeeting.window.id === window.id) {
      // If URL is still null but we have a title for Google Meet, construct the URL
      let meetingUrl = window.url;
      if (!meetingUrl && window.platform === 'google-meet' && window.title) {
        meetingUrl = `https://meet.google.com/${window.title}`;
        console.log(`[Main] Constructed Google Meet URL from title in meeting-updated: ${meetingUrl}`);
      }

      detectedMeeting = {
        ...detectedMeeting,
        window: {
          ...detectedMeeting.window,
          title: window.title,
          url: meetingUrl || window.url // Use constructed URL if available, otherwise use window.url
        }
      };

      console.log("Updated meeting title:", window.title);
      if (meetingUrl || window.url) {
        console.log("Updated meeting URL:", meetingUrl || window.url);
      }

      // If a note has already been created for this meeting, update its title retroactively
      if (window.title && global.activeMeetingIds && global.activeMeetingIds[window.id]) {
        const noteId = global.activeMeetingIds[window.id].noteId;
        
        if (noteId) {
          console.log("Updating existing note title for:", noteId);
          
          try {
            // Read the current meetings data
            const meetingsData = await fileOperationManager.readMeetingsData();
            
            // Find the meeting in pastMeetings
            const meeting = meetingsData.pastMeetings.find(m => m.id === noteId);
            
            if (meeting) {
              const oldTitle = meeting.title;
              
              // Update the title and URL
              meeting.title = window.title;
              
              // Use URL from window, or construct it for Google Meet if not available
              let meetingUrl = window.url;
              if (!meetingUrl && window.platform === 'google-meet' && window.title) {
                meetingUrl = `https://meet.google.com/${window.title}`;
                console.log(`[Main] Constructed Google Meet URL for existing note: ${meetingUrl}`);
              }
              
              if (meetingUrl) {
                meeting.url = meetingUrl;
              }
              
              // Save the updated data
              await fileOperationManager.writeData(meetingsData);
              console.log(`Successfully updated meeting title from "${oldTitle}" to "${window.title}"`);
              
              // Notify the renderer to update the UI
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('meeting-title-updated', {
                  meetingId: noteId,
                  newTitle: window.title
                });
              }
            } else {
              console.error("Meeting not found in pastMeetings with ID:", noteId);
            }
          } catch (error) {
            console.error("Error updating meeting title:", error);
          }
        }
      }
    }
  });

  // Listen for meeting closed events
  RecallAiSdk.addEventListener('meeting-closed', (evt) => {
    console.log("Meeting closed:", evt);

    // Log the SDK meeting-closed event
    sdkLogger.logEvent('meeting-closed', {
      windowId: evt.window.id
    });

    // Clean up the global tracking when a meeting ends
    if (evt.window && evt.window.id && global.activeMeetingIds && global.activeMeetingIds[evt.window.id]) {
      console.log(`Cleaning up meeting tracking for: ${evt.window.id}`);
      delete global.activeMeetingIds[evt.window.id];
    }

    detectedMeeting = null;

    // Send the meeting closed status to the renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-detection-status', { detected: false });
    }
  });

  // Listen for recording ended events
  RecallAiSdk.addEventListener('recording-ended', async (evt) => {
    console.log("Recording ended:", evt);

    // Log the SDK recording-ended event
    sdkLogger.logEvent('recording-ended', {
      windowId: evt.window.id
    });

    try {
      // Get the meeting note ID associated with this window
      let noteId = null;
      if (global.activeMeetingIds && global.activeMeetingIds[evt.window.id]) {
        noteId = global.activeMeetingIds[evt.window.id].noteId;
      }
      
      // If noteId not found in global tracking, try to find it from meetings data
      if (!noteId) {
        try {
          const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
          const meetingsData = JSON.parse(fileData);
          const meeting = meetingsData.pastMeetings.find(m => m.recordingId === evt.window.id);
          if (meeting) {
            noteId = meeting.id;
            console.log(`Found noteId ${noteId} from meetings data for recording ${evt.window.id}`);
          }
        } catch (error) {
          console.error('Error looking up noteId from meetings data:', error);
        }
      }

      // Notify renderer process that recording has ended (state is now idle)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-state-change', {
          recordingId: evt.window.id,
          state: 'idle',
          noteId
        });
        console.log(`[Main] Sent recording-state-change (idle) for recording ${evt.window.id}, noteId: ${noteId}`);
      }

      // Update the note with recording information
      // Note: The SDK automatically handles the upload when recording ends
      // because we provided an uploadToken when calling startRecording().
      // We don't need to manually call uploadRecording() here.
      await updateNoteWithRecordingInfo(evt.window.id);
    } catch (error) {
      console.error("Error handling recording ended:", error);
    }
  });

  RecallAiSdk.addEventListener('permissions-granted', async (evt) => {
    console.log("macOS permissions granted:", evt);
    
    // Log which permissions were granted
    if (evt && evt.permissions) {
      console.log("Granted permissions:", evt.permissions);
    } else {
      console.log("All required permissions have been granted");
    }
    
    // Optionally notify the user that permissions are ready
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('permissions-granted', {
        message: 'macOS permissions granted. Meeting detection is now active.'
      });
    }
  });

  // Track upload progress
  RecallAiSdk.addEventListener('upload-progress', async (evt) => {
    const { progress, window } = evt;
    console.log(`Upload progress: ${progress}%`);

    // Log the SDK upload-progress event
    // sdkLogger.logEvent('upload-progress', {
    //   windowId: window.id,
    //   progress
    // });

    // Update the note with upload progress if needed
    if (progress === 100) {
      console.log(`Upload completed for recording: ${window.id}`);
      // Could update the note here with upload completion status
    }
  });

  // Track SDK state changes
  RecallAiSdk.addEventListener('sdk-state-change', async (evt) => {
    const { sdk: { state: { code } }, window } = evt;
    console.log("Recording state changed:", code, "for window:", window?.id);

    // Log the SDK sdk-state-change event
    sdkLogger.logEvent('sdk-state-change', {
      state: code,
      windowId: window?.id
    });

    // Update recording state in our global tracker
    if (window && window.id) {
      // Get the meeting note ID associated with this window
      let noteId = null;
      if (global.activeMeetingIds && global.activeMeetingIds[window.id]) {
        noteId = global.activeMeetingIds[window.id].noteId;
      }

      // Update the recording state in our tracker
      if (code === 'recording') {
        console.log('Recording in progress...');
        if (noteId) {
          // If recording started, add it to our active recordings
          activeRecordings.addRecording(window.id, noteId, window.platform || 'unknown');
        }
      } else if (code === 'paused') {
        console.log('Recording paused');
        activeRecordings.updateState(window.id, 'paused');
      } else if (code === 'idle') {
        console.log('Recording stopped');
        activeRecordings.removeRecording(window.id);
      }

      // Notify renderer process about recording state change
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-state-change', {
          recordingId: window.id,
          state: code,
          noteId
        });
      }
    }
  });

  // Listen for real-time transcript events
  RecallAiSdk.addEventListener('realtime-event', async (evt) => {
    // Log all realtime events for debugging (except video frames to avoid flooding)
    if (evt.event !== 'video_separate_png.data') {
      console.log("Received realtime event:", evt.event);
      console.log("Realtime event data structure:", JSON.stringify({
        event: evt.event,
        hasData: !!evt.data,
        hasNestedData: !!(evt.data && evt.data.data),
        windowId: evt.window?.id
      }, null, 2));

      // Log the SDK realtime-event event
      sdkLogger.logEvent('realtime-event', {
        eventType: evt.event,
        windowId: evt.window?.id
      });
    }

    // Handle different event types
    // Note: The event structure is evt.event for the event type, and evt.data.data for the actual payload
    if (evt.event === 'transcript.data') {
      console.log("[Main] Processing transcript.data event");
      if (evt.data && evt.data.data) {
        await processTranscriptData(evt);
      } else {
        console.warn("[Main] transcript.data event missing data.data:", evt);
      }
    }
    else if (evt.event === 'transcript.provider_data') {
      console.log("[Main] Processing transcript.provider_data event");
      if (evt.data && evt.data.data) {
        await processTranscriptProviderData(evt);
      } else {
        console.warn("[Main] transcript.provider_data event missing data.data:", evt);
      }
    }
    else if (evt.event === 'participant_events.join') {
      console.log("[Main] Processing participant_events.join event");
      if (evt.data && evt.data.data) {
        await processParticipantJoin(evt);
      } else {
        console.warn("[Main] participant_events.join event missing data.data:", evt);
      }
    }
    else if (evt.event === 'video_separate_png.data') {
      if (evt.data && evt.data.data) {
        await processVideoFrame(evt);
      }
    }
    else {
      // Log any other events we're not explicitly handling
      console.log("[Main] Unhandled realtime event type:", evt.event, evt);
    }
  });

  // Handle errors
  RecallAiSdk.addEventListener('error', async (evt) => {
    console.error("RecallAI SDK Error:", evt);
    const { type, message } = evt;

    // Log the SDK error event
    sdkLogger.logEvent('error', {
      errorType: type,
      errorMessage: message
    });

    // Show notification for errors
    let notification = new Notification({
      title: 'Recording Error',
      body: `Error: ${type} - ${message}`
    });
    notification.show();
  });
}

// Export SDK availability status for use in other parts of the code
function isSDKAvailable() {
  return isSDKSupported && isSDKInitialized;
}

// Handle opening login URL
ipcMain.handle('open-login', async (event) => {
  try {
    const backendUrl = config.getBackendUrl();
    const redirectUrl = encodeURIComponent('/login/desktop?scheme=chatsheet-recall');
    const loginURL = `${backendUrl}/login?redirectUrl=${redirectUrl}`;
    
    console.log('Opening login URL:', loginURL);
    await shell.openExternal(loginURL);
    return { success: true };
  } catch (error) {
    console.error('Error opening login URL:', error);
    return { success: false, error: error.message };
  }
});

// Handle logout
ipcMain.handle('logout', async (event) => {
  try {
    console.log('Logging out user...');
    
    // Clear the session token (preserve current environment)
    const currentConfig = config.loadConfig();
    config.saveConfig(null, currentConfig.environment, currentConfig.customBackendUrl);
    
    console.log('Session token cleared');
    
    // Show the login view in the main window instead of opening a separate dialog
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-login-view');
    } else {
      // If main window doesn't exist, create config window as fallback
      if (!configWindow || configWindow.isDestroyed()) {
        createConfigWindow();
      } else {
        configWindow.show();
        configWindow.focus();
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error during logout:', error);
    return { success: false, error: error.message };
  }
});

// Handle saving API configuration (legacy support - now uses session token)
ipcMain.handle('save-api-config', async (event, sessionToken, backendUrl) => {
  try {
    const currentConfig = config.loadConfig();
    // If backendUrl is provided and different, try to match it to an environment or set as custom
    let environment = currentConfig.environment;
    let customBackendUrl = currentConfig.customBackendUrl;
    
    if (backendUrl) {
      const foundEnv = Object.keys(config.ENVIRONMENTS).find(env => 
        config.ENVIRONMENTS[env].backendUrl === backendUrl
      );
      if (foundEnv) {
        environment = foundEnv;
        customBackendUrl = null;
      } else {
        environment = 'custom';
        customBackendUrl = backendUrl;
      }
    }
    
    const success = config.saveConfig(sessionToken, environment, customBackendUrl);
    if (success) {
      console.log('Configuration saved successfully');
      return { success: true };
    } else {
      return { success: false, error: 'Failed to save configuration' };
    }
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error.message };
  }
});

// Handle saving environment configuration
ipcMain.handle('save-environment', async (event, environment, customBackendUrl) => {
  try {
    const success = config.saveEnvironment(environment, customBackendUrl);
    if (success) {
      console.log('Environment configuration saved successfully');
      return { success: true };
    } else {
      return { success: false, error: 'Failed to save environment configuration' };
    }
  } catch (error) {
    console.error('Error saving environment config:', error);
    return { success: false, error: error.message };
  }
});

// Handle getting current environment configuration
ipcMain.handle('get-environment-config', async () => {
  try {
    const currentConfig = config.loadConfig();
    return {
      success: true,
      environment: currentConfig.environment || config.DEFAULT_ENVIRONMENT,
      customBackendUrl: currentConfig.customBackendUrl || null,
      backendUrl: config.getBackendUrl(), // Computed, not stored
      environments: config.ENVIRONMENTS
    };
  } catch (error) {
    console.error('Error getting environment config:', error);
    return { success: false, error: error.message };
  }
});

// Handle config saved event from config dialog
ipcMain.on('config-saved', () => {
  console.log("Config saved, closing config dialog and initializing app");
  if (configWindow) {
    configWindow.close();
  }
  // If main window exists and login view is shown, hide it and initialize
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('login-success');
  }
  // Initialize the app now that config is saved
  initializeApp();
});

// Handle saving meetings data
ipcMain.handle('saveMeetingsData', async (event, data) => {
  try {
    // Use the file operation manager to safely write the file
    await fileOperationManager.writeData(data);
    return { success: true };
  } catch (error) {
    console.error('Failed to save meetings data:', error);
    return { success: false, error: error.message };
  }
});

// Debug handler to check if IPC handlers are registered
ipcMain.handle('debugGetHandlers', async () => {
  console.log("Checking registered IPC handlers...");
  const handlers = Object.keys(ipcMain._invokeHandlers);
  console.log("Registered handlers:", handlers);
  return handlers;
});

// Handler to get active recording ID for a note
ipcMain.handle('getActiveRecordingId', async (event, noteId) => {
  console.log(`getActiveRecordingId called for note: ${noteId}`);

  try {
    // If noteId is provided, get recording for that specific note
    if (noteId) {
      const recordingInfo = activeRecordings.getForNote(noteId);
      return {
        success: true,
        data: recordingInfo
      };
    }

    // Otherwise return all active recordings
    return {
      success: true,
      data: activeRecordings.getAll()
    };
  } catch (error) {
    console.error('Error getting active recording ID:', error);
    return { success: false, error: error.message };
  }
});

// Handle deleting a meeting
ipcMain.handle('deleteMeeting', async (event, meetingId) => {
  try {
    console.log(`Deleting meeting with ID: ${meetingId}`);

    // Read current data
    const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
    const meetingsData = JSON.parse(fileData);

    // Find the meeting
    const pastMeetingIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === meetingId);
    const upcomingMeetingIndex = meetingsData.upcomingMeetings.findIndex(meeting => meeting.id === meetingId);

    let meetingDeleted = false;
    let recordingId = null;

    // Remove from past meetings if found
    if (pastMeetingIndex !== -1) {
      // Store the recording ID for later cleanup if needed
      recordingId = meetingsData.pastMeetings[pastMeetingIndex].recordingId;

      // Remove the meeting
      meetingsData.pastMeetings.splice(pastMeetingIndex, 1);
      meetingDeleted = true;
    }

    // Remove from upcoming meetings if found
    if (upcomingMeetingIndex !== -1) {
      // Store the recording ID for later cleanup if needed
      recordingId = meetingsData.upcomingMeetings[upcomingMeetingIndex].recordingId;

      // Remove the meeting
      meetingsData.upcomingMeetings.splice(upcomingMeetingIndex, 1);
      meetingDeleted = true;
    }

    if (!meetingDeleted) {
      return { success: false, error: 'Meeting not found' };
    }

    // Save the updated data
    await fileOperationManager.writeData(meetingsData);

    // If the meeting had a recording, cleanup the reference in the global tracking
    if (recordingId && global.activeMeetingIds && global.activeMeetingIds[recordingId]) {
      console.log(`Cleaning up tracking for deleted meeting with recording ID: ${recordingId}`);
      delete global.activeMeetingIds[recordingId];
    }

    console.log(`Successfully deleted meeting: ${meetingId}`);
    return { success: true };
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return { success: false, error: error.message };
  }
});

// Handle generating AI summary for a meeting (non-streaming)
ipcMain.handle('generateMeetingSummary', async (event, meetingId) => {
  try {
    console.log(`Manual summary generation requested for meeting: ${meetingId}`);

    // Read current data
    const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
    const meetingsData = JSON.parse(fileData);

    // Find the meeting
    const pastMeetingIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === meetingId);

    if (pastMeetingIndex === -1) {
      return { success: false, error: 'Meeting not found' };
    }

    const meeting = meetingsData.pastMeetings[pastMeetingIndex];

    // Check if there's a transcript to summarize
    if (!meeting.transcript || meeting.transcript.length === 0) {
      return {
        success: false,
        error: 'No transcript available for this meeting'
      };
    }

    // Log summary generation to console instead of showing a notification
    console.log('Generating AI summary for meeting: ' + meetingId);

    // Generate the summary
    const summary = await generateMeetingSummary(meeting);

    // Get meeting title for use in the new content
    const meetingTitle = meeting.title || "Meeting Notes";

    // Get recording ID
    const recordingId = meeting.recordingId;

    // Check for different possible video file patterns
    const possibleFilePaths = recordingId ? [
      path.join(RECORDING_PATH, `${recordingId}.mp4`),
      path.join(RECORDING_PATH, `macos-desktop-${recordingId}.mp4`),
      path.join(RECORDING_PATH, `macos-desktop${recordingId}.mp4`),
      path.join(RECORDING_PATH, `desktop-${recordingId}.mp4`)
    ] : [];

    // Find the first video file that exists
    let videoExists = false;
    let videoFilePath = null;

    try {
      for (const filePath of possibleFilePaths) {
        if (fs.existsSync(filePath)) {
          videoExists = true;
          videoFilePath = filePath;
          console.log(`Found video file at: ${videoFilePath}`);
          break;
        }
      }
    } catch (err) {
      console.error('Error checking for video files:', err);
    }

    // Create content with the AI-generated summary
    meeting.content = `# ${meetingTitle}\n\n${summary}`;

    // If video exists, store the path separately but don't add it to the content
    if (videoExists) {
      meeting.videoPath = videoFilePath; // Store the path for future reference
      console.log(`Stored video path in meeting object: ${videoFilePath}`);
    } else {
      console.log('Video file not found or no recording ID');
    }

    meeting.hasSummary = true;

    // Save the updated data with summary
    await fileOperationManager.writeData(meetingsData);

    console.log('Updated meeting note with AI summary');

    // Notify the renderer to refresh the note if it's open
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-generated', meetingId);
    }

    return {
      success: true,
      summary
    };
  } catch (error) {
    console.error('Error generating meeting summary:', error);
    return { success: false, error: error.message };
  }
});

// Handle starting a manual desktop recording
ipcMain.handle('startManualRecording', async (event, meetingId) => {
  try {
    console.log(`Starting manual desktop recording for meeting: ${meetingId}`);

    // Read current data
    const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
    const meetingsData = JSON.parse(fileData);

    // Find the meeting
    const pastMeetingIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === meetingId);

    if (pastMeetingIndex === -1) {
      return { success: false, error: 'Meeting not found' };
    }

    const meeting = meetingsData.pastMeetings[pastMeetingIndex];

    try {
      // Check if SDK is supported and initialized
      if (!isSDKSupported || !isSDKInitialized) {
        return { 
          success: false, 
          error: `Desktop recording is not supported on ${process.platform}. The Recall.ai Desktop SDK only supports macOS and Windows.` 
        };
      }

      // Prepare desktop audio recording - this is the key difference from our previous implementation
      // It returns a key that we use as the window ID

      // Log the prepareDesktopAudioRecording API call
      sdkLogger.logApiCall('prepareDesktopAudioRecording');

      const key = await RecallAiSdk.prepareDesktopAudioRecording();
      console.log('Prepared desktop audio recording with key:', key);

      // Get meeting URL from the meeting data (if available)
      const meetingUrl = meeting.url || '';

      // Create a recording token
      const uploadData = await createDesktopSdkUpload(meetingUrl);
      if (!uploadData || !uploadData.upload_token) {
        // Error notification is already shown in createDesktopSdkUpload function
        return { success: false, error: 'Failed to create recording token. Please check the error notification for details.' };
      }

      // Store the recording ID in the meeting
      meeting.recordingId = key;

      // Initialize transcript array if not present
      if (!meeting.transcript) {
        meeting.transcript = [];
      }

      // Store tracking info for the recording
      global.activeMeetingIds = global.activeMeetingIds || {};
      global.activeMeetingIds[key] = {
        platformName: 'Desktop Recording',
        noteId: meetingId
      };

      // Register the recording in our active recordings tracker
      activeRecordings.addRecording(key, meetingId, 'Desktop Recording');

      // Save the updated data
      await fileOperationManager.writeData(meetingsData);

      // Start recording with the key from prepareDesktopAudioRecording
      console.log('Starting desktop recording with key:', key);

      // Log the startRecording API call
      sdkLogger.logApiCall('startRecording', {
        windowId: key,
        uploadToken: `${uploadData.upload_token.substring(0, 8)}...` // Log truncated token for security
      });

      try {
        await RecallAiSdk.startRecording({
          windowId: key,
          uploadToken: uploadData.upload_token
        });
      } catch (recordingError) {
        console.error('Error starting manual recording:', recordingError);
        // Clean up tracking if recording failed to start
        if (global.activeMeetingIds && global.activeMeetingIds[key]) {
          delete global.activeMeetingIds[key];
        }
        activeRecordings.removeRecording(key);
        throw recordingError; // Re-throw to be caught by outer try-catch
      }

      return {
        success: true,
        recordingId: key
      };
    } catch (sdkError) {
      console.error('RecallAI SDK error:', sdkError);
      return { success: false, error: 'Failed to prepare desktop recording: ' + sdkError.message };
    }
  } catch (error) {
    console.error('Error starting manual recording:', error);
    return { success: false, error: error.message };
  }
});

// Handle stopping a manual desktop recording
ipcMain.handle('stopManualRecording', async (event, recordingId) => {
  try {
    console.log(`Stopping manual desktop recording: ${recordingId}`);

    // Check if SDK is supported and initialized
    if (!isSDKSupported || !isSDKInitialized) {
      return { 
        success: false, 
        error: `Desktop recording is not supported on ${process.platform}. The Recall.ai Desktop SDK only supports macOS and Windows.` 
      };
    }

    // Stop the recording - using the windowId property as shown in the reference

    // Log the stopRecording API call
    sdkLogger.logApiCall('stopRecording', {
      windowId: recordingId
    });

    // Update our active recordings tracker
    activeRecordings.updateState(recordingId, 'stopping');

    try {
      await RecallAiSdk.stopRecording({
        windowId: recordingId
      });

      // The recording-ended event will be triggered automatically,
      // which will handle uploading and generating the summary

      return { success: true };
    } catch (stopError) {
      console.error('Error stopping recording:', stopError);
      // If the meeting doesn't exist, that's okay - it might have already been stopped
      if (stopError.message && stopError.message.includes('Could not find meeting')) {
        console.log('Meeting already stopped or not found, continuing cleanup');
        return { success: true }; // Return success since the goal (stopping) is achieved
      }
      return { success: false, error: stopError.message || 'Failed to stop recording' };
    }
  } catch (error) {
    console.error('Error stopping manual recording:', error);
    return { success: false, error: error.message };
  }
});

// Handle generating AI summary with streaming
ipcMain.handle('generateMeetingSummaryStreaming', async (event, meetingId) => {
  try {
    console.log(`Streaming summary generation requested for meeting: ${meetingId}`);

    // Read current data
    const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
    const meetingsData = JSON.parse(fileData);

    // Find the meeting
    const pastMeetingIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === meetingId);

    if (pastMeetingIndex === -1) {
      return { success: false, error: 'Meeting not found' };
    }

    const meeting = meetingsData.pastMeetings[pastMeetingIndex];

    // Check if there's a transcript to summarize
    if (!meeting.transcript || meeting.transcript.length === 0) {
      return {
        success: false,
        error: 'No transcript available for this meeting'
      };
    }

    // Log summary generation to console instead of showing a notification
    console.log('Generating streaming summary for meeting: ' + meetingId);

    // Get meeting title for use in the new content
    const meetingTitle = meeting.title || "Meeting Notes";

    // Initial content with placeholders
    meeting.content = `# ${meetingTitle}\n\nGenerating summary...`;

    // Update the note on the frontend right away
    mainWindow.webContents.send('summary-update', {
      meetingId,
      content: meeting.content
    });

    // Create progress callback for streaming updates
    const streamProgress = (currentText) => {
      // Update content with current streaming text
      meeting.content = `# ${meetingTitle}\n\n## AI-Generated Meeting Summary\n${currentText}`;

      // Send immediate update to renderer - don't debounce or delay this
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          // Force immediate send of the update
          mainWindow.webContents.send('summary-update', {
            meetingId,
            content: meeting.content,
            timestamp: Date.now() // Add timestamp to ensure uniqueness
          });
        } catch (err) {
          console.error('Error sending streaming update to renderer:', err);
        }
      }
    };

    // Generate summary with streaming
    const summary = await generateMeetingSummary(meeting, streamProgress);

    // Check if summary generation failed (returns error message)
    if (summary && summary.startsWith('Error generating summary:')) {
      console.error('Summary generation failed:', summary);
      
      // Extract error message for display
      const errorMessage = summary.replace('Error generating summary: ', '');
      
      // Restore original content (don't save error message as content)
      // Reload the meeting data to get the original content
      const originalFileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      const originalMeetingsData = JSON.parse(originalFileData);
      const originalMeeting = originalMeetingsData.pastMeetings.find(m => m.id === meetingId);
      if (originalMeeting) {
        meeting.content = originalMeeting.content;
      }
      
      console.log('Summary generation failed, restored original content.');
      
      // Show error notification and dialog to user
      try {
        let notification = new Notification({
          title: 'Summary Generation Error',
          body: `Failed to generate AI summary: ${errorMessage}`,
          urgency: 'critical'
        });
        notification.show();
        console.log("[Main] Summary error notification shown to user");
        
        // Also show a dialog to ensure user sees it
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Summary Generation Error',
            message: 'Failed to generate AI summary',
            detail: errorMessage,
            buttons: ['OK']
          }).catch(err => {
            console.error("[Main] Failed to show summary error dialog:", err);
          });
        }
      } catch (notifError) {
        console.error("[Main] Failed to show summary error notification:", notifError);
        // Fallback: show dialog if notification fails
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Summary Generation Error',
            message: 'Failed to generate AI summary',
            detail: errorMessage,
            buttons: ['OK']
          }).catch(err => {
            console.error("[Main] Failed to show summary error dialog:", err);
          });
        }
      }
      
      // Return error instead of success
      return {
        success: false,
        error: errorMessage
      };
    }

    // Summary generation succeeded - update content
    // Make sure the final content is set correctly
    meeting.content = `# ${meetingTitle}\n\n${summary}`;
    meeting.hasSummary = true;

    // Save the updated data with summary
    await fileOperationManager.writeData(meetingsData);

    console.log('Updated meeting note with AI summary (streaming)');

    // Final notification to renderer
    mainWindow.webContents.send('summary-generated', meetingId);

    return {
      success: true,
      summary
    };
  } catch (error) {
    console.error('Error generating streaming summary:', error);
    return { success: false, error: error.message };
  }
});

// Handle loading meetings data
ipcMain.handle('loadMeetingsData', async () => {
  try {
    // Use our file operation manager to safely read the data
    const data = await fileOperationManager.readMeetingsData();

    // Return the data
    return {
      success: true,
      data: data
    };
  } catch (error) {
    console.error('Failed to load meetings data:', error);
    return { success: false, error: error.message };
  }
});

// Function to create a new meeting note and start recording
async function createMeetingNoteAndRecord(platformName) {
  console.log("Creating meeting note for platform:", platformName);
  try {
    if (!detectedMeeting) {
      console.error('No active meeting detected');
      return;
    }
    console.log("Detected meeting info:", detectedMeeting.window.id, detectedMeeting.window.platform);

    // Store the meeting window ID for later reference with transcript events
    global.activeMeetingIds = global.activeMeetingIds || {};
    global.activeMeetingIds[detectedMeeting.window.id] = { platformName };

    // Read the current meetings data
    let meetingsData;
    try {
      const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      meetingsData = JSON.parse(fileData);
    } catch (error) {
      console.error('Error reading meetings data:', error);
      meetingsData = { upcomingMeetings: [], pastMeetings: [] };
    }

    // Generate a unique ID for the new meeting
    const id = 'meeting-' + Date.now();

    // Current date and time
    const now = new Date();

    // Use the actual meeting title if available, otherwise fall back to platform name + time
    // NOTE: meeting-updated may fire after the user clicks to join, so this might not be
    // populated yet. The meeting-updated handler will update the title retroactively if needed.
    const meetingTitle = detectedMeeting.window.title 
      ? detectedMeeting.window.title 
      : `${platformName} Meeting - ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    // Create a template for the note content
    const template = `# ${meetingTitle}\nRecording: In Progress...`;

    // Create a new meeting object
    const newMeeting = {
      id: id,
      type: 'document',
      title: meetingTitle,
      subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      hasDemo: false,
      date: now.toISOString(),
      participants: [],
      content: template,
      recordingId: detectedMeeting.window.id,
      platform: platformName,
      url: detectedMeeting.window.url || '', // Store meeting URL if available
      transcript: [] // Initialize an empty array for transcript data
    };

    // Update the active meeting tracking with the note ID
    if (global.activeMeetingIds && global.activeMeetingIds[detectedMeeting.window.id]) {
      global.activeMeetingIds[detectedMeeting.window.id].noteId = id;
    }

    // Register this meeting in our active recordings tracker (even before starting)
    // This ensures the UI knows about it immediately
    activeRecordings.addRecording(detectedMeeting.window.id, id, platformName);

    // Add to pastMeetings
    meetingsData.pastMeetings.unshift(newMeeting);

    // Save the updated data
    console.log(`Saving meeting data to ${meetingsFilePath} with ID: ${id}`);
    await fileOperationManager.writeData(meetingsData);

    // Verify the file was written by reading it back
    try {
      const verifyData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      const parsedData = JSON.parse(verifyData);
      const verifyMeeting = parsedData.pastMeetings.find(m => m.id === id);

      if (verifyMeeting) {
        console.log(`Successfully verified meeting ${id} was saved`);

        // Tell the renderer to open the new note
        if (mainWindow && !mainWindow.isDestroyed()) {
          // We need a significant delay to make sure the file is fully processed and loaded
          // This ensures the renderer has time to process the file and recognize the new meeting
          setTimeout(async () => {
            try {
              // Force a file reload before sending the message
              await fs.promises.readFile(meetingsFilePath, 'utf8');

              console.log(`Sending IPC message to open meeting note: ${id}`);
              mainWindow.webContents.send('open-meeting-note', id);

              // Send another message after 2 seconds as a backup
              setTimeout(() => {
                console.log(`Sending backup IPC message to open meeting note: ${id}`);
                mainWindow.webContents.send('open-meeting-note', id);
              }, 2000);
            } catch (error) {
              console.error('Error before sending open-meeting-note message:', error);
            }
          }, 1500); // Increased delay for safety
        }
      } else {
        console.error(`Meeting ${id} not found in saved data!`);
      }
    } catch (verifyError) {
      console.error('Error verifying saved data:', verifyError);
    }

    // Start recording with upload token
    console.log('Starting recording for meeting:', detectedMeeting.window.id);

    // Check if SDK is supported and initialized before attempting to record
    if (!isSDKSupported || !isSDKInitialized) {
      console.warn(`Cannot start recording: SDK not available on ${process.platform}`);
      return id; // Return the meeting ID even though recording won't start
    }

    try {
      // Get meeting URL from detected meeting
      let meetingUrl = '';
      if (detectedMeeting && detectedMeeting.window) {
        // First, try to use the URL from the window object
        if (detectedMeeting.window.url) {
          meetingUrl = detectedMeeting.window.url;
        } else if (detectedMeeting.window.platform === 'google-meet' && detectedMeeting.window.title) {
          // For Google Meet, if URL is not available, construct it from the title (meeting code)
          // Google Meet titles are typically the meeting code (e.g., "ghf-cpgo-vfx")
          meetingUrl = `https://meet.google.com/${detectedMeeting.window.title}`;
          console.log(`[Main] Constructed Google Meet URL from title: ${meetingUrl}`);
        } else if (detectedMeeting.window.platform === 'zoom' && detectedMeeting.window.title) {
          console.log(`[Main] Zoom meeting detected but URL not available. Title: ${detectedMeeting.window.title}`);
        }
      }
      
      // Get upload token
      const uploadData = await createDesktopSdkUpload(meetingUrl);
      if (!uploadData || !uploadData.upload_token) {
        console.error('Failed to get upload token. Cannot start recording without upload token.');
        // Error notification is already shown in createDesktopSdkUpload function
        // Don't attempt to start recording without a token - the SDK requires it
        return id; // Return the meeting ID even though recording won't start
      } else {
        console.log('Starting recording with upload token:', uploadData.upload_token);

        // Log the startRecording API call with upload token
        sdkLogger.logApiCall('startRecording', {
          windowId: detectedMeeting.window.id,
          uploadToken: `${uploadData.upload_token.substring(0, 8)}...` // Log truncated token for security
        });

        try {
          await RecallAiSdk.startRecording({
            windowId: detectedMeeting.window.id,
            uploadToken: uploadData.upload_token
          });
        } catch (recordingError) {
          console.error('Error starting recording:', recordingError);
          // Don't throw - just log the error and continue
        }
      }
    } catch (error) {
      console.error('Error starting recording with upload token:', error);
      // Don't attempt fallback - recording requires an upload token
      console.error('Recording cannot be started without a valid upload token.');
    }

    return id;
  } catch (error) {
    console.error('Error creating meeting note:', error);
  }
}

// Function to process video frames
async function processVideoFrame(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in video frame event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the video data
    const frameData = evt.data.data;
    if (!frameData || !frameData.buffer) {
      console.log("No video frame data in event");
      return;
    }

    // Get data from the event
    const frameBuffer = frameData.buffer; // base64 encoded PNG
    const frameTimestamp = frameData.timestamp;
    const frameType = frameData.type; // 'webcam' or 'screenshare'
    const participantData = frameData.participant;

    // Extract participant info
    const participantId = participantData?.id;
    const participantName = participantData?.name || 'Unknown';

    // Log minimal info to avoid flooding the console
    // console.log(`Received ${frameType} frame from ${participantName} (ID: ${participantId}) at ${frameTimestamp.absolute}`);

    // Send the frame to the renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('video-frame', {
        noteId,
        participantId,
        participantName,
        frameType,
        buffer: frameBuffer,
        timestamp: frameTimestamp
      });
    }
  } catch (error) {
    console.error('Error processing video frame:', error);
  }
}

// Function to process participant join events
async function processParticipantJoin(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in participant join event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the participant data
    const participantData = evt.data.data.participant;
    if (!participantData) {
      console.log("No participant data in event");
      return;
    }

    const participantName = participantData.name || "Unknown Participant";
    const participantId = participantData.id;
    const isHost = participantData.is_host;
    const platform = participantData.platform;

    console.log(`Participant joined: ${participantName} (ID: ${participantId}, Host: ${isHost})`);

    // Skip "Host" and "Guest" generic names
    if (participantName === "Host" || participantName === "Guest" || participantName.includes("others") || (participantName.split(" ").length > 3)) {
      console.log(`Skipping generic participant name: ${participantName}`);
      return;
    }

    // Use the file operation manager to safely update the meetings data
    await fileOperationManager.scheduleOperation(async (meetingsData) => {
      // Find the meeting note with this ID
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === noteId);
      if (noteIndex === -1) {
        console.log(`No meeting note found with ID: ${noteId}`);
        return null; // Return null to indicate no changes needed
      }

      // Get the meeting and initialize participants array if needed
      const meeting = meetingsData.pastMeetings[noteIndex];
      if (!meeting.participants) {
        meeting.participants = [];
      }

      // Check if participant already exists (based on ID)
      const existingParticipantIndex = meeting.participants.findIndex(p => p.id === participantId);

      if (existingParticipantIndex !== -1) {
        // Update existing participant
        meeting.participants[existingParticipantIndex] = {
          id: participantId,
          name: participantName,
          isHost: isHost,
          platform: platform,
          joinTime: new Date().toISOString(),
          status: 'active'
        };
      } else {
        // Add new participant
        meeting.participants.push({
          id: participantId,
          name: participantName,
          isHost: isHost,
          platform: platform,
          joinTime: new Date().toISOString(),
          status: 'active'
        });
      }

      console.log(`Added/updated participant data for meeting: ${noteId}`);

      // Notify the renderer if this note is currently being edited
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('participants-updated', noteId);
      }

      // Return the updated data to be written
      return meetingsData;
    });

    console.log(`Processed participant join event for meeting: ${noteId}`);
  } catch (error) {
    console.error('Error processing participant join event:', error);
  }
}

let currentUnknownSpeaker = -1;

async function processTranscriptProviderData(evt) {
  // let speakerId = evt.data.data.payload.
  try {
    if (evt.data.data.data.payload.channel.alternatives[0].words[0].speaker !== undefined) {
      currentUnknownSpeaker = evt.data.data.data.payload.channel.alternatives[0].words[0].speaker;
    }
  } catch (error) {
    // console.error("Error processing provider data:", error);
  }
}

// Function to process transcript data and store it with the meeting note
async function processTranscriptData(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in transcript event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the transcript data
    const words = evt.data.data.words || [];
    if (words.length === 0) {
      return; // No words to process
    }

    // Get speaker information
    let speaker;
    if (evt.data.data.participant?.name && evt.data.data.participant?.name !== "Host" && evt.data.data.participant?.name !== "Guest") {
      speaker = evt.data.data.participant?.name;
    } else if (currentUnknownSpeaker !== -1) {
      speaker = `Speaker ${currentUnknownSpeaker}`;
    } else {
      speaker = "Unknown Speaker";
    }

    // Combine all words into a single text
    const text = words.map(word => word.text).join(" ");

    console.log(`Transcript from ${speaker}: "${text}"`);

    // Use the file operation manager to safely update the meetings data
    await fileOperationManager.scheduleOperation(async (meetingsData) => {
      // Find the meeting note with this ID
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === noteId);
      if (noteIndex === -1) {
        console.log(`No meeting note found with ID: ${noteId}`);
        return null; // Return null to indicate no changes needed
      }

      // Add the transcript data
      const meeting = meetingsData.pastMeetings[noteIndex];

      // Initialize transcript array if it doesn't exist
      if (!meeting.transcript) {
        meeting.transcript = [];
      }

      // Add the new transcript entry
      meeting.transcript.push({
        text,
        speaker,
        timestamp: new Date().toISOString()
      });

      // Update the meeting content with the transcript
      // Format: Replace "Recording: In Progress..." with the transcript
      const meetingTitle = meeting.title || "Meeting Notes";
      
      // Format transcript entries for display
      const transcriptText = meeting.transcript.map(entry => 
        `**${entry.speaker}**: ${entry.text}`
      ).join('\n\n');
      
      // Update content: replace "Recording: In Progress..." with transcript
      if (meeting.content.includes("Recording: In Progress...")) {
        meeting.content = `# ${meetingTitle}\n\n## Transcript\n\n${transcriptText}`;
      } else {
        // If content already has transcript, append the new entry
        // Extract existing transcript section or append to it
        if (meeting.content.includes("## Transcript")) {
          // Replace the transcript section with updated one
          const beforeTranscript = meeting.content.split("## Transcript")[0];
          meeting.content = `${beforeTranscript}## Transcript\n\n${transcriptText}`;
        } else {
          // Append transcript section if it doesn't exist
          meeting.content = `${meeting.content}\n\n## Transcript\n\n${transcriptText}`;
        }
      }

      console.log(`Added transcript data for meeting: ${noteId}`);

      // Notify the renderer if this note is currently being edited
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript-updated', noteId);
        console.log(`Sent transcript update to renderer for meeting: ${noteId}`);
      }

      // Return the updated data to be written
      return meetingsData;
    });

    console.log(`Processed transcript data for meeting: ${noteId}`);
  } catch (error) {
    console.error('Error processing transcript data:', error);
  }
}

// Function to generate AI summary from transcript with streaming support
async function generateMeetingSummary(meeting, progressCallback = null) {
  try {
    if (!meeting.transcript || meeting.transcript.length === 0) {
      console.log('No transcript available to summarize');
      return 'No transcript available to summarize.';
    }

    console.log(`Generating AI summary for meeting: ${meeting.id}`);

    // Format the transcript into a single text for the AI to process
    const transcriptText = meeting.transcript.map(entry =>
      `${entry.speaker}: ${entry.text}`
    ).join('\n');

    // Format detected participants if available
    let participantsText = "";
    if (meeting.participants && meeting.participants.length > 0) {
      participantsText = "Detected participants:\n" + meeting.participants.map(p =>
        `- ${p.name}${p.isHost ? ' (Host)' : ''}`
      ).join('\n');
    }

    // Define a system prompt to guide the AI's response with a specific format
    const systemMessage =
      "You are an AI assistant that summarizes meeting transcripts. " +
      "You MUST format your response using the following structure:\n\n" +
      "# Participants\n" +
      "- [List all participants mentioned in the transcript]\n\n" +
      "# Summary\n" +
      "- [Key discussion point 1]\n" +
      "- [Key discussion point 2]\n" +
      "- [Key decisions made]\n" +
      "- [Include any important deadlines or dates mentioned]\n\n" +
      "# Action Items\n" +
      "- [Action item 1] - [Responsible person if mentioned]\n" +
      "- [Action item 2] - [Responsible person if mentioned]\n" +
      "- [Add any other action items discussed]\n\n" +
      "Stick strictly to this format with these exact section headers. Keep each bullet point concise but informative.";

    // Prepare the messages array for the API
    const messages = [
      { role: "system", content: systemMessage },
      {
        role: "user", content: `Summarize the following meeting transcript with the EXACT format specified in your instructions:
${participantsText ? participantsText + "\n\n" : ""}
Transcript:
${transcriptText}`
      }
    ];

    // If no progress callback provided, use the non-streaming version
    if (!progressCallback) {
      // Call the OpenAI API (via OpenRouter) for summarization (non-streaming)
      const response = await openai.chat.completions.create({
        model: MODELS.PRIMARY, // Use our primary model for a good balance of quality and speed
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
        fallbacks: MODELS.FALLBACKS, // Use our defined fallback models
        transform_to_openai: true, // Ensures consistent response format across models
        route: "fallback" // Automatically use fallbacks if the primary model is unavailable
      });

      // Log which model was actually used
      console.log(`AI summary generated successfully using model: ${response.model}`);

      // Return the generated summary
      return response.choices[0].message.content;
    } else {
      // Use streaming version and accumulate the response
      let fullText = '';

      // Create a streaming request
      const stream = await openai.chat.completions.create({
        model: MODELS.PRIMARY, // Use our primary model for a good balance of quality and speed
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
        stream: true,
        fallbacks: MODELS.FALLBACKS, // Use our defined fallback models
        transform_to_openai: true, // Ensures consistent response format across models
        route: "fallback" // Automatically use fallbacks if the primary model is unavailable
      });

      // Handle streaming events
      return new Promise((resolve, reject) => {
        // Process the stream
        (async () => {
          try {
            // Log the model being used when first chunk arrives (if available)
            let modelLogged = false;

            for await (const chunk of stream) {
              // Log the model on first chunk if available
              if (!modelLogged && chunk.model) {
                console.log(`Streaming with model: ${chunk.model}`);
                modelLogged = true;
              }

              // Extract the text content from the chunk
              const content = chunk.choices[0]?.delta?.content || '';

              if (content) {
                // Add the new text chunk to our accumulated text
                fullText += content;

                // Log each token for debugging (less verbose)
                if (content.length < 50) {
                  console.log(`Received token: "${content}"`);
                } else {
                  console.log(`Received content of length: ${content.length}`);
                }

                // Call the progress callback immediately with each token
                if (progressCallback) {
                  progressCallback(fullText);
                }
              }
            }

            console.log('AI summary streaming completed');
            resolve(fullText);
          } catch (error) {
            console.error('Stream error:', error);
            reject(error);
          }
        })();
      });
    }
  } catch (error) {
    console.error('Error generating meeting summary:', error);

    // Check if it's an OpenRouter/OpenAI specific error
    if (error.status) {
      return `Error generating summary: API returned status ${error.status}: ${error.message}`;
    } else if (error.response) {
      // Handle errors with a response object
      return `Error generating summary: ${error.response.status} - ${error.response.data?.error?.message || error.message}`;
    } else {
      // Default error handling
      return `Error generating summary: ${error.message}`;
    }
  }
}

// Function to update a note with recording information when recording ends
async function updateNoteWithRecordingInfo(recordingId) {
  try {
    // Read the current meetings data
    let meetingsData;
    try {
      const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      meetingsData = JSON.parse(fileData);
    } catch (error) {
      console.error('Error reading meetings data:', error);
      return;
    }

    // Find the meeting note with this recording ID
    const noteIndex = meetingsData.pastMeetings.findIndex(meeting =>
      meeting.recordingId === recordingId
    );

    if (noteIndex === -1) {
      console.log('No meeting note found for recording ID:', recordingId);
      return;
    }

    // Format current date
    const now = new Date();
    const formattedDate = now.toLocaleString();

    // Update the meeting note content
    const meeting = meetingsData.pastMeetings[noteIndex];
    const content = meeting.content;

    // Replace the "Recording: In Progress..." line with completed information
    let updatedContent = content.replace(
      "Recording: In Progress...",
      `Recording: Completed at ${formattedDate}\n`
    );

    // Update the meeting object
    meeting.content = updatedContent;
    meeting.recordingComplete = true;
    meeting.recordingEndTime = now.toISOString();

    // Save the initial update
    await fileOperationManager.writeData(meetingsData);

    // Generate AI summary if there's a transcript AND API key is configured
    if (meeting.transcript && meeting.transcript.length > 0) {
      // Check if OpenAI API key is configured before attempting summary generation
      // Check both the client's apiKey property and environment variables
      const hasApiKey = (openai.apiKey && openai.apiKey.trim() !== '') || 
                       process.env.OPENAI_API_KEY || 
                       process.env.OPENROUTER_API_KEY;
      
      if (!hasApiKey) {
        console.log('OpenAI/OpenRouter API key not configured. Skipping auto-summary generation.');
        console.log('Users can manually generate summary if they configure an API key via OPENAI_API_KEY or OPENROUTER_API_KEY environment variable.');
        // Keep the transcript content - don't overwrite it
        return;
      }

      console.log(`Generating AI summary for meeting ${meeting.id}...`);

      // Log summary generation to console instead of showing a notification
      console.log('Generating AI summary for meeting: ' + meeting.id);

      // Get meeting title for use in the new content
      const meetingTitle = meeting.title || "Meeting Notes";

      // Store the original content (with transcript) before attempting summary
      const originalContent = meeting.content;

      // Create initial content with placeholder
      meeting.content = `# ${meetingTitle}\nGenerating summary...`;

      // Notify any open editors immediately
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('summary-update', {
          meetingId: meeting.id,
          content: meeting.content
        });
      }

      // Create progress callback for streaming updates
      const streamProgress = (currentText) => {
        // Update content with current streaming text
        meeting.content = `# ${meetingTitle}\n\n${currentText}`;

        // Send immediate update to renderer if note is open
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('summary-update', {
              meetingId: meeting.id,
              content: meeting.content,
              timestamp: Date.now() // Add timestamp to ensure uniqueness
            });
          } catch (err) {
            console.error('Error sending streaming update to renderer:', err);
          }
        }
      };

      try {
        // Generate the summary with streaming updates
        const summary = await generateMeetingSummary(meeting, streamProgress);

        // Check if summary generation failed (returns error message)
        if (summary && summary.startsWith('Error generating summary:')) {
          console.error('Summary generation failed:', summary);
          
          // Extract error message for display
          const errorMessage = summary.replace('Error generating summary: ', '');
          
          // Restore original content (with transcript) instead of showing error
          meeting.content = originalContent;
          console.log('Restored original transcript content. Summary generation failed.');
          
          // Show error notification and dialog to user
          try {
            let notification = new Notification({
              title: 'Summary Generation Error',
              body: `Failed to generate AI summary: ${errorMessage}`,
              urgency: 'critical'
            });
            notification.show();
            console.log("[Main] Summary error notification shown to user");
            
            // Also show a dialog to ensure user sees it
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Summary Generation Error',
                message: 'Failed to generate AI summary',
                detail: errorMessage,
                buttons: ['OK']
              }).catch(err => {
                console.error("[Main] Failed to show summary error dialog:", err);
              });
            }
          } catch (notifError) {
            console.error("[Main] Failed to show summary error notification:", notifError);
            // Fallback: show dialog if notification fails
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Summary Generation Error',
                message: 'Failed to generate AI summary',
                detail: errorMessage,
                buttons: ['OK']
              }).catch(err => {
                console.error("[Main] Failed to show summary error dialog:", err);
              });
            }
          }
        } else {
          // Summary generation succeeded - update content
          // Check for different possible video file patterns
          const possibleFilePaths = [
            path.join(RECORDING_PATH, `${recordingId}.mp4`),
            path.join(RECORDING_PATH, `macos-desktop-${recordingId}.mp4`),
            path.join(RECORDING_PATH, `macos-desktop${recordingId}.mp4`),
            path.join(RECORDING_PATH, `desktop-${recordingId}.mp4`)
          ];

          // Find the first video file that exists
          let videoExists = false;
          let videoFilePath = null;

          try {
            for (const filePath of possibleFilePaths) {
              if (fs.existsSync(filePath)) {
                videoExists = true;
                videoFilePath = filePath;
                console.log(`Found video file at: ${videoFilePath}`);
                break;
              }
            }
          } catch (err) {
            console.error('Error checking for video files:', err);
          }

          console.log("Attempting to embed video file", videoFilePath);

          // Set the content to just the summary
          meeting.content = `${summary}`;

          // If video exists, store the path separately but don't add it to the content
          if (videoExists) {
            meeting.videoPath = videoFilePath; // Store the path for future reference
            console.log(`Stored video path in meeting object: ${videoFilePath}`);
          } else {
            console.log('Video file not found, continuing without embedding');
          }

          meeting.hasSummary = true;

          // Save the updated data with summary
          await fileOperationManager.writeData(meetingsData);

          console.log('Updated meeting note with AI summary');
        }
      } catch (error) {
        console.error('Error during summary generation:', error);
        
        // Extract user-friendly error message
        let errorMessage = 'An unexpected error occurred during summary generation';
        if (error.message) {
          errorMessage = error.message;
        } else if (error.status) {
          errorMessage = `API returned status ${error.status}: ${error.message || 'Unknown error'}`;
        } else if (error.response) {
          errorMessage = `Request failed: ${error.response.status} - ${error.response.data?.error?.message || error.message || 'Unknown error'}`;
        }
        
        // Restore original content (with transcript) instead of showing error
        meeting.content = originalContent;
        console.log('Restored original transcript content due to error.');
        
        // Show error notification and dialog to user
        try {
          let notification = new Notification({
            title: 'Summary Generation Error',
            body: `Failed to generate AI summary: ${errorMessage}`,
            urgency: 'critical'
          });
          notification.show();
          console.log("[Main] Summary error notification shown to user (from catch block)");
          
          // Also show a dialog to ensure user sees it
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'error',
              title: 'Summary Generation Error',
              message: 'Failed to generate AI summary',
              detail: errorMessage,
              buttons: ['OK']
            }).catch(err => {
              console.error("[Main] Failed to show summary error dialog:", err);
            });
          }
        } catch (notifError) {
          console.error("[Main] Failed to show summary error notification:", notifError);
          // Fallback: show dialog if notification fails
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'error',
              title: 'Summary Generation Error',
              message: 'Failed to generate AI summary',
              detail: errorMessage,
              buttons: ['OK']
            }).catch(err => {
              console.error("[Main] Failed to show summary error dialog:", err);
            });
          }
        }
      }
    }

    // If the note is currently open, notify the renderer to refresh it
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-completed', meeting.id);
    }
  } catch (error) {
    console.error('Error updating note with recording info:', error);
  }
}

// Function to check if there's a detected meeting available
ipcMain.handle('checkForDetectedMeeting', async () => {
  return detectedMeeting !== null;
});

// Function to join the detected meeting
ipcMain.handle('joinDetectedMeeting', async () => {
  return joinDetectedMeeting();
});

// Function to handle joining a detected meeting
async function joinDetectedMeeting() {
  try {
    console.log("Join detected meeting called");

    if (!detectedMeeting) {
      console.log("No detected meeting available");
      return { success: false, error: "No active meeting detected" };
    }

    // Map platform codes to readable names
    const platformNames = {
      'zoom': 'Zoom',
      'google-meet': 'Google Meet',
      'slack': 'Slack',
      'teams': 'Microsoft Teams'
    };

    // Get a user-friendly platform name, or use the raw platform name if not in our map
    const platformName = platformNames[detectedMeeting.window.platform] || detectedMeeting.window.platform;

    console.log("Joining detected meeting for platform:", platformName);

    // Ensure main window exists and is visible
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log("Creating new main window");
      createWindow();
    }

    // Bring window to front with focus
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    // Process with more reliable timing
    return new Promise((resolve) => {
      // Wait a moment for the window to be fully focused and ready
      setTimeout(async () => {
        console.log("Window is ready, creating new meeting note");

        try {
          // Create a new meeting note and start recording
          const id = await createMeetingNoteAndRecord(platformName);

          console.log("Created new meeting with ID:", id);
          resolve({ success: true, meetingId: id });
        } catch (err) {
          console.error("Error creating meeting note:", err);
          resolve({ success: false, error: err.message });
        }
      }, 800); // Increased timeout for more reliability
    });
  } catch (error) {
    console.error("Error in joinDetectedMeeting:", error);
    return { success: false, error: error.message };
  }
}
