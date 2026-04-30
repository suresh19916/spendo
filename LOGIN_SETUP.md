# Spendo - Setup Instructions with Login System

## Overview
Your Spendo expense tracker now includes a secure login system that validates user credentials against a Google Sheet and generates API keys with 3-minute expiration times.

## Setup Steps

### 1. Update Google Apps Script
1. Open your Google Sheet
2. Go to **Extensions → Apps Script**
3. Replace your existing Code.gs with the updated version (includes login functionality)
4. Save the script (Ctrl+S)

### 2. Create Login Users
1. In the Apps Script editor, run the `createTestUsers()` function manually:
   - Click on `createTestUsers` in the function dropdown
   - Click the **Run** button (▶️)
   - Authorize permissions if prompted
2. This will create a "Login" sheet with test users:
   - **ID**: admin, **Password**: admin123
   - **ID**: user1, **Password**: password123  
   - **ID**: demo, **Password**: demo123

### 3. Add Custom Users (Optional)
To add your own users manually:
1. Run the `addLoginUser("yourID", "yourPassword")` function in Apps Script
2. Or directly edit the "Login" sheet in your Google Sheet with columns:
   - **ID**: User identifier
   - **Pass**: User password
   - **API Key**: (Leave empty - generated automatically)
   - **Expire**: (Leave empty - set automatically)

### 4. Deploy the Updated Script
1. Click **Deploy → New deployment**
2. Choose type: **Web app**
3. Set **Execute as**: Me
4. Set **Who has access**: Anyone
5. Click **Deploy**
6. Copy the new Web App URL

### 5. Update Your Application
1. If you haven't set up the URL yet, paste it when prompted
2. If you have an existing URL, update it in Settings

## How the Login System Works

### Authentication Flow
1. **Setup**: User enters the Google Apps Script Web App URL
2. **Login**: User enters their ID and Password
3. **Validation**: System checks credentials against the Login sheet
4. **API Key Generation**: If valid, generates a secure API key with 3-minute expiration
5. **Session Management**: All subsequent requests include the API key for validation

### Security Features
- **API Keys**: 32-character random keys with "SPD_" prefix
- **Expiration**: Keys automatically expire after 3 minutes
- **Session Validation**: Checks expiry before each API call
- **Auto-Logout**: Forces re-login when session expires
- **Secure Storage**: Credentials never stored in browser, only temporary API keys

### User Experience
- **Automatic Login**: Remembers valid sessions until expiry
- **Session Warnings**: Notifies users when sessions expire
- **Offline Mode**: Still works with cached data when offline
- **Easy Logout**: One-click logout clears session

## Sheet Structure

### Login Sheet Columns
| Column | Description | Example |
|--------|-------------|---------|
| ID | User identifier | admin |
| Pass | User password | admin123 |
| API Key | Generated token | SPD_xyz123... |
| Expire | Expiration time | 2026-04-29 15:30:00 |

### Transactions Sheet (unchanged)
Your existing transaction data structure remains the same.

## Troubleshooting

### Common Issues
1. **"Invalid credentials"**: Check ID/Password in Login sheet
2. **"Session expired"**: Normal after 3 minutes, just login again
3. **"Connection failed"**: Verify Apps Script URL and deployment
4. **Login sheet not found**: Run `createTestUsers()` function

### Security Notes
- Change default passwords immediately after setup
- Users can only access their own data (no user isolation in current version)
- Consider implementing user-specific data sheets for multi-user scenarios
- API keys are automatically cleaned up when expired

## Next Steps
- Test login with default credentials
- Add your own users
- Consider implementing user roles/permissions
- Monitor the Login sheet for active sessions

Your expense tracker is now secure with user authentication! 🔐