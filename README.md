# Aliasify

A Spicetify extension that lets you replace cover art and rename any album, single, EP, or track everywhere inside Spotify. All changes are display-only and stored locally on your device.

## Features

* **Custom Cover Art:** Swap out artwork for any album, single, EP, or song across the entire Spotify interface.
  * Supports clicking to browse, drag-and-drop, or pasting directly from your clipboard (`Ctrl+V` / `Cmd+V`).
  * Automatically crops images to a square (up to 1024×1024) and saves them persistently in IndexedDB.
* **Dynamic Theme Color Sync:** Recalculates Spotify's extracted accent colors from your custom cover so dynamic themes adapt to your new artwork.
* **Rename Albums & Songs:** Change the display title of any album and its individual tracks simultaneously.
  * Smart context matching ensures only the targeted release is renamed—other tracks or albums sharing the same name are left untouched.
  * Does not alter Spotify's underlying playback state, keeping lyrics, scrobbling, and playback working normally.
* **One-Click Restore:** Easily revert individual covers, track names, or entire albums back to their originals at any time.

## How to Use

### Change Cover Art
1. Right-click (or click the `...` menu on) any album, track, or card and select **Change cover art**, or click the **pencil icon** in the player bar for the currently playing song.
2. Click the cover preview, drag and drop an image file, or paste an image from your clipboard.
3. Click **Save**. To revert later, open the editor again and click **Restore original**.

### Rename Albums & Songs
1. Right-click (or click `...`) on any album or song and select **Rename album / songs**.
2. Edit the album title and/or any track titles in the list.
3. Click **Save**. Use the `↺` button next to any field or **Restore originals** at the bottom to undo changes.

## Installation

### Via Spicetify Marketplace (Recommended)
1. Open Spotify and navigate to the **Marketplace** tab.
2. Search for **Aliasify** under Extensions.
3. Click **Install**.

### Manual Installation
1. Download `aliasify.js`.
2. Place it in your Spicetify `Extensions` folder:
   * **Windows:** `%appdata%\spicetify\Extensions\`
   * **Linux / macOS:** `~/.config/spicetify/Extensions/`
3. Run the following commands in your terminal:
   ```bash
   spicetify config extensions aliasify.js
   spicetify apply
   ```
