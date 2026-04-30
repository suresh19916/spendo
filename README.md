# 📊 Spendo — Secure Expense Tracker
### Google Apps Script + Authentication System

---

## What You'll Have After This Setup
- A **secure, mobile-friendly expense tracker** with user authentication
- **Login system** that validates credentials and generates API keys
- All your data **saved in your own Google Sheet** (private and secure)
- **3-minute session expiry** for enhanced security
- A **free public URL** via GitHub Pages — no server, no cost

---

## 🔐 NEW: Authentication Features
- **User Login System**: Secure ID/Password authentication
- **API Key Generation**: Temporary keys with 3-minute expiration  
- **Session Management**: Auto-logout on expiry
- **Multi-user Support**: Multiple users can have separate credentials
- **Security**: No passwords stored in browser, only temporary tokens

---

## STEP 1 — Set Up the Google Sheet & Apps Script

### 1a. Create a Google Sheet
1. Go to [sheets.google.com](https://sheets.google.com)
2. Click **+ Blank** to create a new spreadsheet
3. Rename it to **"Spendo Data"** (top-left title)

### 1b. Open Apps Script
1. In your Sheet, click **Extensions** → **Apps Script**
2. A new tab opens with a code editor
3. **Delete** all the existing code in the editor

### 1c. Paste the Backend Code
1. Open the `Code.gs` file from this project
2. Copy **all** its contents
3. Paste into the Apps Script editor
4. Press **Ctrl+S** (or Cmd+S on Mac) to save
5. Name the project **"Spendo"** when prompted

---

## STEP 2 — Deploy as a Web App

1. In the Apps Script editor, click **Deploy** → **New deployment**
2. Click the ⚙️ gear icon next to "Select type" → choose **Web app**
3. Fill in the settings:
   - **Description**: `Spendo API`
   - **Execute as**: `Me`
   - **Who has access**: `Anyone`
4. Click **Deploy**
5. Click **Authorize access** → choose your Google account → Allow
6. **Copy the Web App URL** — it looks like:
   ```
   https://script.google.com/macros/s/AKfycby.../exec
   ```
   ⚠️ **Save this URL** — you'll need it in Step 3!

---

## STEP 3 — Set Up GitHub Pages (Free Hosting)

### 3a. Create a GitHub account
Go to [github.com](https://github.com) and sign up (free)

### 3b. Create a new repository
1. Click **+** → **New repository**
2. Repository name: `spendo` (or any name)
3. Set visibility to **Public** ✅
4. Click **Create repository**

### 3c. Upload your files
1. In your new repo, click **Add file** → **Upload files**
2. Upload both:
   - `index.html`
   - `Code.gs` *(optional — just for reference)*
3. Click **Commit changes**

### 3d. Enable GitHub Pages
1. Go to your repo's **Settings** tab
2. Click **Pages** in the left sidebar
3. Under **Source**: select **Deploy from a branch**
4. Branch: `main` | Folder: `/ (root)`
5. Click **Save**

### 3e. Get your URL
After ~1 minute, your app is live at:
```
https://YOUR_GITHUB_USERNAME.github.io/spendo/
```

---

## STEP 4 — Connect the App to Your Sheet

1. Open your GitHub Pages URL on your phone
2. You'll see a **setup screen** asking for the Apps Script URL
3. Paste the URL you copied in Step 2
4. Click **Connect & Launch**

---

## STEP 5 — Set Up Login Users

### 5a. Create Test Users (Automatic)
1. Go back to your Google Apps Script editor
2. Find the `createTestUsers` function in the function dropdown
3. Click **Run** ▶️ to create default users:
   - **ID**: `admin` **Password**: `admin123`
   - **ID**: `user1` **Password**: `password123`
   - **ID**: `demo` **Password**: `demo123`

### 5b. Add Custom Users (Optional)
To add your own users:
1. Run the function: `addLoginUser("yourID", "yourPassword")`
2. Or manually edit the "Login" sheet in your Google Sheet

### 5c. First Login
1. Return to your Spendo app
2. Use any of the test credentials to login
3. Your session will be valid for 3 minutes
4. **Important**: Change the default passwords after testing!

---

## 🔒 Security Features

- **3-Minute Sessions**: API keys automatically expire for security
- **No Password Storage**: Passwords never stored in browser
- **Secure API Keys**: Random 32-character tokens  
- **Auto-Logout**: Forces re-authentication on expiry
- **Session Validation**: Checks credentials on every request

---
4. Tap **Connect & Launch** ✅

> **That's it!** Every transaction you add is instantly saved to your Google Sheet.

---

## OPTIONAL: Hardcode the URL (skip the setup screen)

If you want the app to launch directly without a setup screen:

1. Open `index.html`
2. Find this line near the top:
   ```javascript
   var APPS_SCRIPT_URL = "YOUR_APPS_SCRIPT_URL";
   ```
3. Replace `YOUR_APPS_SCRIPT_URL` with your actual URL:
   ```javascript
   var APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby.../exec";
   ```
4. Save and push to GitHub — the app will auto-connect on load

---

## How to Add to Phone Home Screen

**iPhone (Safari):**
1. Open your GitHub Pages URL in Safari
2. Tap the **Share** button (bottom center)
3. Scroll down → tap **Add to Home Screen**
4. Tap **Add** — it appears like a native app!

**Android (Chrome):**
1. Open your GitHub Pages URL in Chrome
2. Tap the **⋮ menu** (top right)
3. Tap **Add to Home screen**
4. Tap **Add**

---

## How Re-deploying Works (if you update Code.gs)

If you ever update `Code.gs`, you must **create a new deployment**:
1. Apps Script → **Deploy** → **Manage deployments**
2. Click ✏️ Edit → change **Version** to **New version**
3. Click **Deploy** — your URL stays the same ✅

---

## Your Data in Google Sheets

Your Sheet will have two tabs auto-created:
| Tab | Contents |
|-----|----------|
| `Transactions` | ID, Type, Amount, Description, Category, Date, Emoji, MonthKey |
| `Salary` | MonthKey, Salary amount |

All data is **100% yours** in your Google account. The GitHub repo is public but contains no personal data or keys.
# spendo
