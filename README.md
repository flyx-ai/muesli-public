# Muesli

This is a demo application that shows off what you can build with the [Recall.ai Desktop Recording SDK.](https://www.recall.ai/product/desktop-recording-sdk)

This repo is intended to be a mockup of the kind of experience you can build using the Desktop Recording SDK.

Need help? Reach out to our support team [support@recall.ai](mailto:support@recall.ai).

# Setup

1. Install dependencies:
```sh
npm ci
# or
npm install
```

2. Run the application:
```sh
npm start
```

## Building and Packaging

### Package the App

To create packaged app bundles (unpacked):
```bash
npm run package
```

This creates platform-specific packages in the `out` directory.

### Create Installers/Distributables

To create installers and distributables (DMG for macOS, EXE for Windows):
```bash
npm run make
```

Output files will be in the `out/make` directory:
- **macOS**: `.dmg` file and `.zip` archive
- **Windows**: `.exe` installer (Squirrel)

### macOS DMG Installation

If you see a "file damaged" error when opening the DMG (dialog shows only "Eject Disk Image" and "Cancel"):

**Required fix:** Open Terminal and run:
```bash
xattr -d com.apple.quarantine ~/Downloads/Muesli-*.dmg
```

Then try opening the DMG again. The right-click method won't work if you see the "file damaged" error.

See [REMOVE_QUARANTINE.md](REMOVE_QUARANTINE.md) for detailed instructions.

### Platform-Specific Builds

**For macOS** (must run on macOS):
```bash
npm run package -- --platform=darwin
npm run make -- --platform=darwin
```

**For Windows** (must run on Windows):
```bash
npm run package -- --platform=win32
npm run make -- --platform=win32
```

# Screenshots

![Screenshot 2025-06-16 at 10 10 57 PM](https://github.com/user-attachments/assets/9df12246-b5be-466d-958e-e09ff0b4b3cb)
![Screenshot 2025-06-16 at 10 22 44 PM](https://github.com/user-attachments/assets/685f13ab-7c02-4f29-a987-830d331c4d36)
![Screenshot 2025-06-16 at 10 14 38 PM](https://github.com/user-attachments/assets/75817823-084c-46b0-bbe8-e0195a3f9051)
