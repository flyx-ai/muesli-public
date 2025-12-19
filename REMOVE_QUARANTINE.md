# How to Remove Quarantine Attribute from DMG Files

When you download a DMG file from the internet, macOS automatically adds a "quarantine" attribute to protect your system. This causes the "file damaged" error with a dialog showing only "Eject Disk Image" and "Cancel" buttons.

**⚠️ Important:** If you see the "file damaged" dialog with only "Eject" and "Cancel" buttons, you MUST use the Terminal method below. The right-click method won't work because the DMG can't be opened at all.

## Method 1: Using Terminal (REQUIRED for "File Damaged" Error)

**Use this method if you see the error dialog with only "Eject Disk Image" and "Cancel" buttons.**

### Step-by-Step:

1. **Open Terminal**
   - Press `Cmd + Space` to open Spotlight
   - Type "Terminal" and press Enter
   - Or go to Applications → Utilities → Terminal

2. **Navigate to Downloads folder** (if not already there):
   ```bash
   cd ~/Downloads
   ```

3. **Find your DMG file name**:
   ```bash
   ls *.dmg
   ```
   This will show all DMG files in your Downloads folder.

4. **Remove quarantine attribute**:
   ```bash
   xattr -d com.apple.quarantine Muesli-1.0.0-arm64.dmg
   ```
   Replace `Muesli-1.0.0-arm64.dmg` with your actual filename.

5. **Try opening the DMG again** - it should work now!

### Quick One-Liner:

If you know the filename pattern:
```bash
xattr -d com.apple.quarantine ~/Downloads/Muesli-*.dmg
```

Or for any DMG in Downloads:
```bash
xattr -d com.apple.quarantine ~/Downloads/*.dmg
```

---

## Method 2: Using Finder (Only Works After Removing Quarantine)

**⚠️ Note:** This method only works if the DMG can be opened. If you see the "file damaged" error with only "Eject" and "Cancel" buttons, you MUST use Method 1 (Terminal) first.

After removing quarantine with Method 1, you can use this method for future downloads:

1. **Right-click** on the DMG file in Finder
2. Select **"Open"** (not double-click)
3. macOS will show a security warning
4. Click **"Open"** in the dialog
5. The DMG should now open

**Note:** This method only works if the DMG isn't blocked by quarantine. For the "file damaged" error, always use Method 1 first.

---

## Method 3: Remove Quarantine from Multiple Files

If you have multiple DMG files:
```bash
cd ~/Downloads
for file in *.dmg; do
  xattr -d com.apple.quarantine "$file"
done
```

---

## Verify Quarantine is Removed

To check if quarantine was removed:
```bash
xattr -l ~/Downloads/Muesli-*.dmg
```

If you see `com.apple.quarantine` in the output, it's still there. If you see nothing or no quarantine attribute, it's been removed successfully.

---

## What Each Command Does

- `xattr -d com.apple.quarantine <file>` - **Deletes** the quarantine attribute
- `xattr -l <file>` - **Lists** all extended attributes (to verify)
- `xattr -c <file>` - **Clears** all extended attributes (more aggressive)

---

## Troubleshooting

### "No such xattr: com.apple.quarantine"
- This means the file doesn't have quarantine (good!)
- The file should open normally

### "Permission denied"
- Make sure you're in the correct directory
- Try using the full path: `xattr -d com.apple.quarantine ~/Downloads/filename.dmg`

### File still won't open
- Verify the download completed: Check file size matches expected size
- Try downloading again
- Check if the file is actually a DMG: `file ~/Downloads/filename.dmg`

---

## Why This Happens

macOS Gatekeeper adds quarantine attributes to files downloaded from:
- Web browsers (Safari, Chrome, Firefox, etc.)
- Email attachments
- Files from network shares
- Any file from an "untrusted" source

This is a security feature to prevent malicious software from running automatically.

---

## Summary

**Quick fix:**
```bash
xattr -d com.apple.quarantine ~/Downloads/Muesli-*.dmg
```

**Then open the DMG normally!**

