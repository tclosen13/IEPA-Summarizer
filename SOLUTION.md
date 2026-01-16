# IEPA Document Summarizer - Complete Technical Solution

## Executive Summary

This document provides a comprehensive solution for automating environmental document review from the Illinois EPA Document Explorer and DocuWare systems. The solution addresses the core challenge: **extracting text from scanned/encrypted PDFs served by DocuWare**.

---

## Problem Analysis

### Why Current PDF Extraction Fails

1. **DocuWare Session Authentication**: DocuWare URLs like `docuware7.illinois.gov/DocuWare/PlatformRO/WebClient/...` require active browser sessions
2. **Scanned Documents**: Most LUST documents from 1990s-2000s are scanned images without text layers
3. **Dynamic URLs**: DocuWare generates session-specific URLs that expire quickly

### Document Sources

| Source | URL Pattern | Accessibility |
|--------|-------------|---------------|
| IEPA Document Explorer | `webapps.illinois.gov/EPA/DocumentExplorer/` | Public, navigable |
| DocuWare (LUST documents) | `docuware7.illinois.gov/DocuWare/PlatformRO/...` | Session-based, requires navigation |

---

## Solution Architecture

### Recommended Approach: Browser Automation + OCR Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Interface                           │
│  [Enter Facility ID/Name] → [Search] → [Select Documents]       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Playwright Browser Automation                 │
│  1. Navigate to IEPA Document Explorer                          │
│  2. Search for facility                                          │
│  3. Open facility record                                         │
│  4. Navigate to Imaged Documents                                 │
│  5. Click each document to get fresh download URL                │
│  6. Download PDF to local storage                                │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PDF Processing Pipeline                     │
│  1. Try native text extraction (pdf-parse)                       │
│  2. If < 100 chars extracted → Convert to images                │
│  3. Run OCR (Tesseract or Google Vision)                        │
│  4. Clean and structure extracted text                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AI Summarization (OpenAI)                    │
│  GPT-4o-mini with environmental-specific prompt                  │
│  Output: 200-word structured summary                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Structured Output                         │
│  - Facility Overview                                             │
│  - Per-document summaries with contaminants, media, actions     │
│  - Export to DOCX/PDF/Clipboard                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Options

### Option A: Full Browser Automation (Recommended)

**Technology**: Playwright + Tesseract.js + OpenAI

**Pros**:
- Handles session authentication automatically
- Works with any document the user can access
- Can navigate complex JavaScript-heavy interfaces

**Cons**:
- Slower (5-10 seconds per document)
- Requires more server resources

### Option B: Hybrid Approach

**Technology**: Direct HTTP + Playwright fallback + OCR

**Pros**:
- Faster for accessible documents
- Falls back gracefully

**Cons**:
- More complex error handling

### Option C: Manual URL + Enhanced OCR

**Technology**: User-provided URLs + Robust OCR pipeline

**Pros**:
- Simpler architecture
- User controls document selection

**Cons**:
- DocuWare URLs expire quickly
- User must manually copy URLs

---

## Detailed Implementation

### 1. Project Structure

```
iepa-summarizer/
├── app/
│   ├── page.tsx                    # Main UI
│   ├── layout.tsx                  # App layout
│   ├── api/
│   │   ├── search-facility/
│   │   │   └── route.ts           # Facility search endpoint
│   │   ├── fetch-documents/
│   │   │   └── route.ts           # Document list endpoint
│   │   ├── download-pdf/
│   │   │   └── route.ts           # PDF download with browser
│   │   ├── extract-text/
│   │   │   └── route.ts           # OCR/text extraction
│   │   └── summarize/
│   │       └── route.ts           # AI summarization
├── lib/
│   ├── playwright-scraper.ts       # Browser automation
│   ├── pdf-processor.ts            # PDF text extraction
│   ├── ocr-service.ts              # OCR processing
│   └── openai-summarizer.ts        # AI summarization
├── components/
│   ├── FacilitySearch.tsx
│   ├── DocumentList.tsx
│   ├── SummaryCard.tsx
│   └── ExportButton.tsx
└── types/
    └── index.ts
```

### 2. Key Code Components

#### Browser Automation (lib/playwright-scraper.ts)

```typescript
import { chromium, Browser, Page } from 'playwright';

interface FacilitySearchResult {
  id: string;
  name: string;
  address: string;
  city: string;
  county: string;
  programs: string[];
}

interface DocumentInfo {
  id: string;
  type: string;
  date: string;
  category: string;
  downloadUrl?: string;
}

export class IEPAScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async init() {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    this.page = await this.browser.newPage();
  }

  async searchFacility(query: string): Promise<FacilitySearchResult[]> {
    if (!this.page) throw new Error('Browser not initialized');
    
    // Navigate to Document Explorer
    await this.page.goto('https://webapps.illinois.gov/EPA/DocumentExplorer/Attributes');
    
    // Wait for search form
    await this.page.waitForSelector('#FacilitySiteSearch', { timeout: 10000 });
    
    // Fill search form
    await this.page.fill('input[name="Name"]', query);
    
    // Submit search
    await this.page.click('button[type="submit"]');
    
    // Wait for results
    await this.page.waitForSelector('.search-results', { timeout: 15000 });
    
    // Extract results
    const results = await this.page.evaluate(() => {
      const items = document.querySelectorAll('.facility-item');
      return Array.from(items).map(item => ({
        id: item.getAttribute('data-id') || '',
        name: item.querySelector('.facility-name')?.textContent || '',
        address: item.querySelector('.facility-address')?.textContent || '',
        city: item.querySelector('.facility-city')?.textContent || '',
        county: item.querySelector('.facility-county')?.textContent || '',
        programs: Array.from(item.querySelectorAll('.program-badge')).map(b => b.textContent || '')
      }));
    });
    
    return results;
  }

  async getDocuments(facilityId: string): Promise<DocumentInfo[]> {
    if (!this.page) throw new Error('Browser not initialized');
    
    // Navigate to facility page
    await this.page.goto(`https://webapps.illinois.gov/EPA/DocumentExplorer/Facility/${facilityId}`);
    
    // Wait for documents section
    await this.page.waitForSelector('.imaged-documents', { timeout: 10000 });
    
    // Click to expand documents
    await this.page.click('.imaged-documents-toggle');
    
    // Wait for document list
    await this.page.waitForSelector('.document-grid', { timeout: 10000 });
    
    // Extract document info
    const documents = await this.page.evaluate(() => {
      const rows = document.querySelectorAll('.document-row');
      return Array.from(rows).map(row => ({
        id: row.getAttribute('data-doc-id') || '',
        type: row.querySelector('.doc-type')?.textContent || '',
        date: row.querySelector('.doc-date')?.textContent || '',
        category: row.querySelector('.doc-category')?.textContent || '',
      }));
    });
    
    return documents;
  }

  async downloadDocument(docId: string): Promise<Buffer> {
    if (!this.page) throw new Error('Browser not initialized');
    
    // Click document to open viewer/get download
    const downloadPromise = this.page.waitForEvent('download');
    await this.page.click(`[data-doc-id="${docId}"] .download-btn`);
    
    const download = await downloadPromise;
    const path = await download.path();
    
    // Read file
    const fs = require('fs');
    return fs.readFileSync(path);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}
```

#### PDF Processing (lib/pdf-processor.ts)

```typescript
import pdf from 'pdf-parse';
import Tesseract from 'tesseract.js';
import { fromPath } from 'pdf2pic';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ExtractionResult {
  text: string;
  method: 'native' | 'ocr';
  pages: number;
  confidence?: number;
}

export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<ExtractionResult> {
  // Step 1: Try native text extraction
  try {
    const data = await pdf(pdfBuffer);
    
    // Check if we got meaningful text
    const cleanText = data.text.replace(/\s+/g, ' ').trim();
    
    if (cleanText.length > 100) {
      return {
        text: cleanText,
        method: 'native',
        pages: data.numpages
      };
    }
  } catch (error) {
    console.log('Native extraction failed, falling back to OCR');
  }

  // Step 2: Convert to images and OCR
  return await performOCR(pdfBuffer);
}

async function performOCR(pdfBuffer: Buffer): Promise<ExtractionResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-'));
  const pdfPath = path.join(tempDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    // Convert PDF to images
    const convert = fromPath(pdfPath, {
      density: 300,
      saveFilename: 'page',
      savePath: tempDir,
      format: 'png',
      width: 2000,
      height: 2600
    });

    // Get page count
    const pdfData = await pdf(pdfBuffer);
    const pageCount = pdfData.numpages;

    let allText = '';
    let totalConfidence = 0;

    // OCR each page
    for (let i = 1; i <= pageCount; i++) {
      const result = await convert(i);
      
      const ocrResult = await Tesseract.recognize(
        result.path,
        'eng',
        {
          logger: m => console.log(m)
        }
      );

      allText += `\n--- Page ${i} ---\n${ocrResult.data.text}`;
      totalConfidence += ocrResult.data.confidence;
    }

    return {
      text: allText.trim(),
      method: 'ocr',
      pages: pageCount,
      confidence: totalConfidence / pageCount
    };
  } finally {
    // Cleanup temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
```

#### AI Summarization (lib/openai-summarizer.ts)

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

interface DocumentSummary {
  documentId: string;
  date: string;
  type: string;
  siteContext: string;
  contaminantsOfConcern: string[];
  impactedMedia: string[];
  keyActions: string;
  relevanceFlag: 'Relevant' | 'Maybe' | 'Not Relevant';
  fullSummary: string;
}

export async function summarizeDocument(
  text: string,
  metadata: { id: string; date: string; type: string }
): Promise<DocumentSummary> {
  const systemPrompt = `You are an expert environmental consultant reviewing Illinois EPA LUST (Leaking Underground Storage Tank) documents. 

Your task is to produce a ~200 word summary that would help another consultant quickly understand the document's key findings.

For each document, extract and report:
1. Document ID, date, and type
2. Brief site context (facility name, address, what happened)
3. Contaminants of concern (BTEX, PNAs/PAHs, VOCs, MTBE, lead, other metals, etc.)
4. Impacted media (soil, groundwater, vapor, surface water, sediment)
5. Key corrective actions, monitoring status, budgets, or closure information
6. Relevance flag: 
   - "Relevant" = Contains contamination data, remediation details, or closure info
   - "Maybe" = Administrative but references technical content
   - "Not Relevant" = Purely administrative (forms, receipts, correspondence with no technical data)

Be specific about contaminant concentrations if mentioned. Note any regulatory standards referenced (TACO, IEPA screening levels, etc.).

If the text appears to be OCR with errors, do your best to interpret the content.`;

  const userPrompt = `Please summarize this environmental document:

Document ID: ${metadata.id}
Date: ${metadata.date}
Type: ${metadata.type}

Document Text:
${text.substring(0, 15000)} // Limit to avoid token overflow

Provide your response in this exact JSON format:
{
  "documentId": "${metadata.id}",
  "date": "${metadata.date}",
  "type": "${metadata.type}",
  "siteContext": "Brief description of site and document purpose",
  "contaminantsOfConcern": ["BTEX", "PAHs", etc],
  "impactedMedia": ["soil", "groundwater", etc],
  "keyActions": "Description of remediation, monitoring, or closure status",
  "relevanceFlag": "Relevant|Maybe|Not Relevant",
  "fullSummary": "Complete 200-word summary paragraph"
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
    temperature: 0.3
  });

  const content = response.choices[0].message.content;
  return JSON.parse(content || '{}');
}

export async function generateFacilityOverview(
  facilityName: string,
  address: string,
  summaries: DocumentSummary[]
): Promise<string> {
  const relevantDocs = summaries.filter(s => s.relevanceFlag === 'Relevant');
  const allContaminants = [...new Set(relevantDocs.flatMap(s => s.contaminantsOfConcern))];
  const allMedia = [...new Set(relevantDocs.flatMap(s => s.impactedMedia))];

  const prompt = `Based on ${summaries.length} documents reviewed for ${facilityName} at ${address}:
  
  - ${relevantDocs.length} relevant documents
  - Contaminants identified: ${allContaminants.join(', ') || 'None specified'}
  - Media affected: ${allMedia.join(', ') || 'None specified'}
  
  Write a 2-4 sentence facility overview summarizing the environmental history and current status.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 200,
    temperature: 0.3
  });

  return response.choices[0].message.content || '';
}
```

### 3. API Routes

#### /api/summarize-pdf/route.ts (Enhanced Version)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { extractTextFromPdf } from '@/lib/pdf-processor';
import { summarizeDocument } from '@/lib/openai-summarizer';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const url = formData.get('url') as string | null;
    const docId = formData.get('docId') as string || 'Unknown';
    const docDate = formData.get('docDate') as string || 'Unknown';
    const docType = formData.get('docType') as string || 'Unknown';

    let pdfBuffer: Buffer;

    if (file) {
      // Direct file upload
      const arrayBuffer = await file.arrayBuffer();
      pdfBuffer = Buffer.from(arrayBuffer);
    } else if (url) {
      // Download from URL
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: `Failed to download PDF: ${response.status}` },
          { status: 400 }
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      pdfBuffer = Buffer.from(arrayBuffer);
    } else {
      return NextResponse.json(
        { error: 'No file or URL provided' },
        { status: 400 }
      );
    }

    // Extract text (with OCR fallback)
    const extraction = await extractTextFromPdf(pdfBuffer);

    if (!extraction.text || extraction.text.length < 50) {
      return NextResponse.json(
        { 
          error: 'Could not extract meaningful text from PDF',
          method: extraction.method,
          textLength: extraction.text?.length || 0
        },
        { status: 422 }
      );
    }

    // Summarize with AI
    const summary = await summarizeDocument(extraction.text, {
      id: docId,
      date: docDate,
      type: docType
    });

    return NextResponse.json({
      success: true,
      extraction: {
        method: extraction.method,
        pages: extraction.pages,
        confidence: extraction.confidence,
        textLength: extraction.text.length
      },
      summary
    });

  } catch (error) {
    console.error('Summarization error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
```

---

## Installation & Deployment

### Prerequisites

```bash
# System dependencies for OCR
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils

# For Playwright
npx playwright install chromium
npx playwright install-deps
```

### Package.json Dependencies

```json
{
  "dependencies": {
    "next": "^15.0.0",
    "react": "^18.0.0",
    "openai": "^4.0.0",
    "playwright": "^1.40.0",
    "pdf-parse": "^1.1.1",
    "tesseract.js": "^5.0.0",
    "pdf2pic": "^3.0.0",
    "sharp": "^0.33.0"
  }
}
```

### Environment Variables

```env
OPENAI_API_KEY=sk-...
NODE_ENV=production
```

---

## Alternative: Enhanced Manual URL Approach

If full browser automation is too complex for your hosting environment, here's an enhanced version that works better with manually-provided URLs:

### User Workflow

1. User navigates to IEPA Document Explorer
2. User finds facility and opens document list
3. User opens each PDF in a new tab (this creates a valid session URL)
4. User copies the URL from browser address bar
5. User pastes URL into app within 5 minutes (before session expires)
6. App downloads and processes PDF

### Code for Session-Aware Download

```typescript
async function downloadWithSession(url: string): Promise<Buffer> {
  // For DocuWare URLs, we need to follow redirects and handle cookies
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'Accept': 'application/pdf',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response.ok) {
    // Try alternative: convert URL to direct download format
    const directUrl = url.replace('/WebClient/Client/', '/WebClient/Download/');
    const retryResponse = await fetch(directUrl, {
      redirect: 'follow',
      headers: {
        'Accept': 'application/pdf',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!retryResponse.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    return Buffer.from(await retryResponse.arrayBuffer());
  }

  return Buffer.from(await response.arrayBuffer());
}
```

---

## Testing Checklist

### Unit Tests

- [ ] PDF text extraction (native)
- [ ] PDF text extraction (OCR)
- [ ] OpenAI summarization
- [ ] Error handling for corrupt PDFs
- [ ] Error handling for empty PDFs

### Integration Tests

- [ ] Full workflow: URL → Download → Extract → Summarize
- [ ] Full workflow: File upload → Extract → Summarize
- [ ] Batch processing multiple documents

### E2E Tests

- [ ] User searches for facility
- [ ] User selects documents
- [ ] Summaries display correctly
- [ ] Export to clipboard works
- [ ] Export to DOCX works

---

## Cost Estimation

### Per Document

| Component | Cost |
|-----------|------|
| OCR (Tesseract, self-hosted) | $0.00 |
| OpenAI GPT-4o-mini (~4000 tokens) | ~$0.002 |
| **Total per document** | **~$0.002** |

### For Typical Project (50 documents)

| Component | Cost |
|-----------|------|
| AI Summarization | $0.10 |
| Server compute | ~$0.05 |
| **Total** | **~$0.15** |

---

## Next Steps

1. **Immediate**: Fix PDF extraction by adding OCR pipeline
2. **Short-term**: Add file upload option as alternative to URL
3. **Medium-term**: Implement Playwright automation for full workflow
4. **Long-term**: Add batch processing and report generation

---

## Support

For issues with:
- **DocuWare URLs expiring**: Use file upload or implement browser automation
- **OCR quality**: Increase image DPI, try Google Vision API
- **Slow processing**: Add job queue with progress indicators
