// app/api/summarize-pdf/route.ts
// Robust PDF summarization API with OCR fallback

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// System prompt for environmental document summarization
const SYSTEM_PROMPT = `You are an expert environmental consultant specializing in Illinois EPA LUST (Leaking Underground Storage Tank) documents and Site Remediation Program files.

Analyze the document and provide a structured summary. Extract:

1. Site Context: Facility name, address, history, document purpose
2. Contaminants of Concern: Specific chemicals (BTEX, PAHs, MTBE, TPH, VOCs, metals, etc.)
3. Impacted Media: Soil, groundwater, soil vapor, surface water, etc.
4. Key Actions: Tank removals, remediation, monitoring, closure status
5. Relevance:
   - "Relevant" = Contains contamination data, remediation details, or closure info
   - "Maybe" = Administrative with technical references
   - "Not Relevant" = Purely administrative

Note concentrations vs standards (TACO, RBCA) when mentioned.

Output valid JSON only.`;

interface ExtractionResult {
  text: string;
  method: 'native' | 'ocr' | 'hybrid';
  pages: number;
  confidence?: number;
}

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

/**
 * Extract text from PDF using pdf-parse
 */
async function extractTextFromPdf(pdfBuffer: Buffer): Promise<ExtractionResult> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(pdfBuffer);
    
    const cleanText = data.text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    
    const wordCount = cleanText.split(/\s+/).filter(w => w.length > 2).length;
    
    if (wordCount > 30) {
      return {
        text: cleanText,
        method: 'native',
        pages: data.numpages,
      };
    }
    
    // If native extraction got very little text, it's likely a scanned document
    // Try OCR
    console.log(`Native extraction found only ${wordCount} words, attempting OCR...`);
    return await performOCR(pdfBuffer, data.numpages);
    
  } catch (error: any) {
    console.error('PDF extraction error:', error);
    throw new Error(`PDF extraction failed: ${error.message}`);
  }
}

/**
 * Perform OCR on PDF pages
 */
async function performOCR(pdfBuffer: Buffer, pageCount: number): Promise<ExtractionResult> {
  try {
    const Tesseract = await import('tesseract.js');
    const { createWorker } = Tesseract;
    
    // For server-side, we need to convert PDF to images
    // This requires pdftoppm (poppler-utils) to be installed
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const { execSync } = await import('child_process');
    
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iepa-ocr-'));
    const pdfPath = path.join(tempDir, 'input.pdf');
    fs.writeFileSync(pdfPath, pdfBuffer);
    
    try {
      // Check if pdftoppm is available
      execSync('which pdftoppm', { encoding: 'utf-8' });
      
      // Convert PDF to images
      const imagePrefix = path.join(tempDir, 'page');
      execSync(`pdftoppm -png -r 200 "${pdfPath}" "${imagePrefix}"`, {
        timeout: 120000,
      });
      
      // Find generated images
      const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.png'));
      
      if (files.length === 0) {
        throw new Error('PDF to image conversion produced no images');
      }
      
      // OCR each image
      const worker = await createWorker('eng');
      let allText = '';
      let totalConfidence = 0;
      const maxPages = Math.min(files.length, 20);
      
      for (let i = 0; i < maxPages; i++) {
        const imagePath = path.join(tempDir, files[i]);
        const { data } = await worker.recognize(imagePath);
        allText += `\n\n--- Page ${i + 1} ---\n${data.text}`;
        totalConfidence += data.confidence;
      }
      
      await worker.terminate();
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
      
      if (allText.length < 100) {
        throw new Error('OCR produced insufficient text');
      }
      
      return {
        text: allText.trim(),
        method: 'ocr',
        pages: pageCount,
        confidence: totalConfidence / maxPages,
      };
      
    } catch (convError: any) {
      // Cleanup on error
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      
      // Check if it's a pdftoppm availability issue
      if (convError.message?.includes('pdftoppm')) {
        throw new Error('OCR requires pdftoppm (poppler-utils). Install with: apt-get install poppler-utils');
      }
      throw convError;
    }
    
  } catch (error: any) {
    console.error('OCR error:', error);
    throw new Error(`OCR failed: ${error.message}`);
  }
}

/**
 * Summarize extracted text using OpenAI
 */
async function summarizeWithAI(
  text: string,
  metadata: { id?: string; name?: string; date?: string; type?: string }
): Promise<DocumentSummary> {
  const docId = metadata.name || metadata.id || 'Unknown Document';
  const docDate = metadata.date || 'Unknown';
  const docType = metadata.type || 'Unknown';
  
  // Truncate to fit context window
  const maxLen = 14000;
  const truncated = text.length > maxLen
    ? text.substring(0, maxLen) + '\n[... truncated ...]'
    : text;
  
  const userPrompt = `Analyze this environmental document:

Document: ${docId}
Date: ${docDate}
Type: ${docType}

Text:
---
${truncated}
---

Respond with JSON:
{
  "documentId": "${docId}",
  "date": "${docDate}",
  "type": "${docType}",
  "siteContext": "2-3 sentences about facility and document purpose",
  "contaminantsOfConcern": ["list of chemicals"],
  "impactedMedia": ["soil", "groundwater", etc],
  "keyActions": "remediation/monitoring/closure status",
  "relevanceFlag": "Relevant|Maybe|Not Relevant",
  "fullSummary": "200-word comprehensive summary"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.2,
    });
    
    const content = response.choices[0].message.content;
    if (!content) throw new Error('Empty AI response');
    
    const parsed = JSON.parse(content);
    
    return {
      documentId: parsed.documentId || docId,
      date: parsed.date || docDate,
      type: parsed.type || docType,
      siteContext: parsed.siteContext || 'No context extracted',
      contaminantsOfConcern: Array.isArray(parsed.contaminantsOfConcern) 
        ? parsed.contaminantsOfConcern : [],
      impactedMedia: Array.isArray(parsed.impactedMedia) 
        ? parsed.impactedMedia : [],
      keyActions: parsed.keyActions || 'No actions identified',
      relevanceFlag: ['Relevant', 'Maybe', 'Not Relevant'].includes(parsed.relevanceFlag)
        ? parsed.relevanceFlag : 'Maybe',
      fullSummary: parsed.fullSummary || 'Summary unavailable',
    };
    
  } catch (error: any) {
    console.error('AI summarization error:', error);
    return {
      documentId: docId,
      date: docDate,
      type: docType,
      siteContext: `Error: ${error.message}`,
      contaminantsOfConcern: [],
      impactedMedia: [],
      keyActions: 'Processing error - manual review required',
      relevanceFlag: 'Maybe',
      fullSummary: `Document processing failed: ${error.message}`,
    };
  }
}

/**
 * POST handler - accepts file upload or URL
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    let pdfBuffer: Buffer;
    let metadata: { id?: string; name?: string; date?: string; type?: string } = {};
    
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      const url = formData.get('url') as string | null;
      
      metadata = {
        id: formData.get('docId') as string || undefined,
        name: formData.get('docName') as string || undefined,
        date: formData.get('docDate') as string || undefined,
        type: formData.get('docType') as string || undefined,
      };
      
      if (file) {
        // File upload
        const arrayBuffer = await file.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuffer);
        metadata.name = metadata.name || file.name;
        
      } else if (url) {
        // URL download
        console.log(`Downloading PDF from: ${url}`);
        
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/pdf,*/*',
          },
          redirect: 'follow',
        });
        
        if (!response.ok) {
          return NextResponse.json({
            error: `Download failed: HTTP ${response.status}`,
            hint: 'DocuWare URLs expire quickly. Try downloading the PDF and uploading it directly.',
          }, { status: 400 });
        }
        
        const arrayBuffer = await response.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuffer);
        
        // Verify it's a PDF
        if (!pdfBuffer.slice(0, 5).toString().startsWith('%PDF')) {
          return NextResponse.json({
            error: 'URL did not return a valid PDF',
            hint: 'The URL may have expired or require authentication.',
          }, { status: 400 });
        }
        
      } else {
        return NextResponse.json({ error: 'No file or URL provided' }, { status: 400 });
      }
      
    } else if (contentType.includes('application/json')) {
      const body = await request.json();
      
      if (!body.url) {
        return NextResponse.json({ error: 'No URL in request body' }, { status: 400 });
      }
      
      metadata = {
        id: body.docId,
        name: body.docName,
        date: body.docDate,
        type: body.docType,
      };
      
      const response = await fetch(body.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/pdf,*/*',
        },
        redirect: 'follow',
      });
      
      if (!response.ok) {
        return NextResponse.json({
          error: `Download failed: HTTP ${response.status}`,
        }, { status: 400 });
      }
      
      const arrayBuffer = await response.arrayBuffer();
      pdfBuffer = Buffer.from(arrayBuffer);
      
    } else {
      return NextResponse.json({ error: 'Unsupported content type' }, { status: 400 });
    }
    
    // Extract text from PDF
    console.log(`Processing PDF: ${metadata.name || 'unnamed'}, ${pdfBuffer.length} bytes`);
    
    const extraction = await extractTextFromPdf(pdfBuffer);
    
    if (!extraction.text || extraction.text.length < 50) {
      return NextResponse.json({
        error: 'Could not extract text from PDF',
        method: extraction.method,
        hint: 'The PDF may be encrypted, corrupted, or contain only images.',
      }, { status: 422 });
    }
    
    console.log(`Extracted ${extraction.text.length} chars using ${extraction.method}`);
    
    // Summarize with AI
    const summary = await summarizeWithAI(extraction.text, metadata);
    
    return NextResponse.json({
      success: true,
      extraction: {
        method: extraction.method,
        pages: extraction.pages,
        textLength: extraction.text.length,
        confidence: extraction.confidence,
      },
      summary,
    });
    
  } catch (error: any) {
    console.error('API error:', error);
    return NextResponse.json({
      error: 'Processing failed',
      message: error.message,
    }, { status: 500 });
  }
}

/**
 * GET handler - health check
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'IEPA Document Summarizer API',
    version: '2.0',
    capabilities: ['pdf-extraction', 'ocr', 'ai-summarization'],
  });
}
