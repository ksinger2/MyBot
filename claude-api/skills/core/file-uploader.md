---
name: file-uploader
description: Upload files to Google Drive, cloud storage, and web forms
triggers:
  - /upload
  - upload file
  - upload to drive
  - upload to google drive
  - post this file
  - submit this file
requires:
  - browse_url
  - click
  - upload_file
  - wait_for_element
  - wait_for_text
  - save_session
  - restore_session
  - ask_user
  - type_input
---

# File Uploader Skill

## Overview
Upload files to various cloud storage services and websites. Handles authentication, file selection, and upload confirmation.

## Supported Platforms

1. **Google Drive** - Primary cloud storage
2. **Generic Web Forms** - Any site with file upload
3. **Dropbox** - Cloud storage alternative
4. **Image Hosts** - Imgur, etc.

## SAFETY RULES

1. **Verify file exists** before attempting upload
2. **Confirm upload destination** with user
3. **Show upload progress/status**
4. **Warn about file size limits**
5. **Don't upload sensitive files** without explicit confirmation

## Google Drive Upload

### First-time Setup
```
1. browse_url('https://drive.google.com')
2. Ask user: "Please log into your Google account. Tell me when you're done."
3. wait_for_element('div[data-tooltip="New"]')
4. save_session('google-drive')
```

### Upload Workflow
```javascript
1. Verify file exists locally:
   // Agent should check file path is valid

2. restore_session('google-drive')
3. browse_url('https://drive.google.com')
4. wait_for_element('div[data-tooltip="New"]')

5. Click "New" button:
   click('div[data-tooltip="New"]')

6. Click "File upload":
   wait_for_element('[aria-label="File upload"]')
   click('[aria-label="File upload"]')
   // This triggers native file picker

7. Handle file input:
   // Google Drive uses a hidden file input
   wait_for_element('input[type="file"]')
   upload_file('input[type="file"]', '[file path]')

8. Wait for upload:
   wait_for_text('Upload complete', 60000)
   // or wait_for_element('[aria-label="Upload complete"]')

9. Get share link (optional):
   // Right-click uploaded file and get link
   click('[data-tooltip="[filename]"]')
   click('[aria-label="Share"]')
   wait_for_element('input[aria-label="Link"]')
   get_element_text('input[aria-label="Link"]')
```

### Upload to Specific Folder
```javascript
1. restore_session('google-drive')
2. browse_url('https://drive.google.com')

3. Navigate to folder:
   // Click through folder hierarchy or search
   type_input('input[aria-label="Search in Drive"]', '[folder name]')
   press_key('Enter')
   click('[data-tooltip="[folder name]"]')  // Double-click to enter

4. Continue with upload workflow step 5+
```

## Generic Web Form Upload

### Identify Upload Field
```javascript
1. browse_url('[form page URL]')
2. Find file input:
   extract_elements('input[type="file"]', ['name', 'accept', 'multiple'])
   // Returns: { name: "attachment", accept: ".pdf,.doc", multiple: false }
```

### Upload Process
```javascript
1. Verify file matches accepted types
2. Check if multiple files allowed

3. ask_user:
   "Upload [filename] to [website]?
   - File size: [X MB]
   - Accepted types: [types]
   - Destination: [form name/purpose]"

4. If confirmed:
   upload_file('input[type="file"]', '[file path]')

5. Verify file attached:
   // Look for filename displayed
   wait_for_text('[filename]')

6. Ask about form submission:
   ask_user: "File attached. Submit the form now?"

7. If confirmed:
   click('[type="submit"]')
   wait_for_navigation()
   // Check for success message
```

## Dropbox Upload

### Setup
```
1. browse_url('https://www.dropbox.com')
2. Ask user to log in
3. save_session('dropbox')
```

### Upload
```javascript
1. restore_session('dropbox')
2. browse_url('https://www.dropbox.com/home')
3. wait_for_element('[data-testid="upload-button"]')

4. click('[data-testid="upload-button"]')
5. click('[data-testid="upload-file-button"]')  // Upload files
6. wait_for_element('input[type="file"]')
7. upload_file('input[type="file"]', '[file path]')
8. wait_for_text('Upload complete')
```

## Image Upload (Imgur)

### Anonymous Upload (No Account Needed)
```javascript
1. browse_url('https://imgur.com')
2. wait_for_element('[class*="upload"]')
3. click('[class*="upload"]')  // New post button
4. wait_for_element('input[type="file"]')
5. upload_file('input[type="file"]', '[image path]')
6. wait_for_text('processing', 5000).catch(() => {})
7. wait_for_element('[class*="post-image"], img[src*="imgur"]', 30000)

// Get link
8. Extract image URL from page or:
   click('[title="Copy link"]')
   // Report the link
```

## Output Formats

### Upload Success
```markdown
## File Uploaded Successfully

**File**: document.pdf
**Size**: 2.4 MB
**Destination**: Google Drive / My Documents
**Time**: 12 seconds

### Access Link
[Open in Drive](https://drive.google.com/file/d/xxx)

### Share Link (if requested)
https://drive.google.com/file/d/xxx/view?usp=sharing
```

### Upload Failed
```markdown
## Upload Failed

**File**: large-video.mp4
**Error**: File size exceeds limit

### Details
- Your file: 150 MB
- Maximum allowed: 100 MB

### Suggestions
1. Compress the file
2. Use a different service (YouTube for video)
3. Split into smaller parts
```

### Multiple Files
```markdown
## Upload Results

| File | Size | Status |
|------|------|--------|
| doc1.pdf | 1.2 MB | ✅ Uploaded |
| doc2.pdf | 0.8 MB | ✅ Uploaded |
| image.png | 5.0 MB | ❌ Too large |

**Successful**: 2/3 files
**Location**: Google Drive / Uploads
```

## Error Handling

### File Not Found
```
"I couldn't find the file at [path]. Please verify:
1. The file path is correct
2. The file exists
3. You have permission to access it"
```

### Not Logged In
```
"You're not logged into [service]. Would you like to:
1. Log in now (I'll open the login page)
2. Use a different service
3. Upload anonymously (if supported)"
```

### File Too Large
```
"The file ([X MB]) exceeds the [service] limit of [Y MB].

Options:
1. Compress the file
2. Use [alternative service] (allows up to [Z MB])
3. Split into multiple files"
```

### Unsupported File Type
```
"[Service] doesn't accept [file type] files.

Accepted types: [list]

Options:
1. Convert to supported format
2. Use a different service"
```

## Platform-Specific Notes

### Google Drive
- Max file size: 5 TB (with sufficient storage)
- Converts Office docs to Google format (optional)
- Requires Google account

### Dropbox
- Max file size: 2 GB (free), 2 GB per file (Basic)
- Automatic sync if desktop app installed
- Requires Dropbox account

### Imgur
- Max file size: 20 MB (images)
- Supports: JPEG, PNG, GIF, APNG, TIFF, MP4, MPEG, AVI, WEBM
- Anonymous uploads allowed

## Example Queries

- "Upload report.pdf to Google Drive" → Google Drive upload
- "Upload this image to imgur" → Imgur anonymous upload
- "Put the file in my Dropbox" → Dropbox upload
- "Upload resume.pdf to the job application form" → Generic form upload
- "Upload all images in /photos to Drive" → Multiple file upload
- "Share the uploaded file with john@example.com" → Upload + share
