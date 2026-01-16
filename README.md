# IEPA Document Summarizer v3.0

**Fully automated** environmental document analysis for Illinois EPA files. Just enter a facility name and get AI-powered summaries of all documents.

## Features

- **Auto-Search**: Enter facility name, address, ZIP, or IEPA ID
- **Auto-Download**: Automatically retrieves all PDFs from IEPA
- **AI Summarization**: GPT-4 extracts contaminants, media, remediation status
- **Tablet-Friendly**: Works on any device with a browser
- **One-Click Export**: Copy full report to clipboard

## Deploy to Railway (5 minutes)

### Step 1: Create GitHub Repository

1. Go to github.com/new
2. Name it `iepa-summarizer`
3. Click "Create repository"

### Step 2: Upload Code

1. Unzip this file
2. In GitHub, click "uploading an existing file"
3. Drag all files from the iepa-railway folder
4. Click "Commit changes"

### Step 3: Deploy on Railway

1. Go to railway.app and sign in with GitHub
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your iepa-summarizer repository
5. Railway will detect the Dockerfile and start building

### Step 4: Add Environment Variable

1. In Railway, click on your deployment
2. Go to "Variables" tab
3. Add: OPENAI_API_KEY = sk-your-key-here

### Step 5: Access Your App

1. Go to "Settings" tab
2. Click "Generate Domain"
3. Your app is live!

## Usage

1. Open the app URL on your tablet
2. Enter a facility name (e.g., "LOSURDO BROTHERS")
3. Click "Search & Summarize"
4. Wait for automatic processing
5. Click "Copy Full Report"

## Cost

- Railway: $5/month free credit
- OpenAI: ~$0.002 per document

## Troubleshooting

- No facilities found: Try different search terms
- Slow processing: Scanned docs need OCR
- Build fails: Check Railway logs
